
function mp4InitSegment(tracks) {
    return muxjs.mp4.generator.initSegment(tracks);
}

/**
 * mux.js
 *
 * Copyright (c) 2014 Brightcove
 * All rights reserved.
 *
 * A lightweight readable stream implemention that handles event dispatching.
 * Objects that inherit from streams should call init in their constructors.
 */
var Stream = function() {
    this.init = function() {
        var listeners = {};
        /**
         * Add a listener for a specified event type.
         * @param type {string} the event name
         * @param listener {function} the callback to be invoked when an event of
         * the specified type occurs
         */
        this.on = function(type, listener) {
            if (!listeners[type]) {
                listeners[type] = [];
            }
            listeners[type].push(listener);
        };
        /**
         * Remove a listener for a specified event type.
         * @param type {string} the event name
         * @param listener {function} a function previously registered for this
         * type of event through `on`
         */
        this.off = function(type, listener) {
            var index;
            if (!listeners[type]) {
                return false;
            }
            index = listeners[type].indexOf(listener);
            listeners[type].splice(index, 1);
            return index > -1;
        };
        /**
         * Trigger an event of the specified type on this stream. Any additional
         * arguments to this function are passed as parameters to event listeners.
         * @param type {string} the event name
         */
        this.trigger = function(type) {
            var callbacks, i, length, args;
            callbacks = listeners[type];
            if (!callbacks) {
                return;
            }
            // Slicing the arguments on every invocation of this method
            // can add a significant amount of overhead. Avoid the
            // intermediate object creation for the common case of a
            // single callback argument
            if (arguments.length === 2) {
                length = callbacks.length;
                for (i = 0; i < length; ++i) {
                    callbacks[i].call(this, arguments[1]);
                }
            } else {
                args = [];
                i = arguments.length;
                for (i = 1; i < arguments.length; ++i) {
                    args.push(arguments[i]);
                }
                length = callbacks.length;
                for (i = 0; i < length; ++i) {
                    callbacks[i].apply(this, args);
                }
            }
        };
        /**
         * Destroys the stream and cleans up.
         */
        this.dispose = function() {
            listeners = {};
        };
    };
};

/**
 * Forwards all `data` events on this stream to the destination stream. The
 * destination stream should provide a method `push` to receive the data
 * events as they arrive.
 * @param destination {stream} the stream that will receive all `data` events
 * @param autoFlush {boolean} if false, we will not call `flush` on the destination
 *                            when the current stream emits a 'done' event
 * @see http://nodejs.org/api/stream.html#stream_readable_pipe_destination_options
 */
Stream.prototype.pipe = function(destination) {
    this.on('data', function(data) {
        destination.push(data);
    });

    this.on('done', function(flushSource) {
        destination.flush(flushSource);
    });

    return destination;
};

// Default stream functions that are expected to be overridden to perform
// actual work. These are provided by the prototype as a sort of no-op
// implementation so that we don't have to check for their existence in the
// `pipe` function above.
Stream.prototype.push = function(data) {
    this.trigger('data', data);
};

Stream.prototype.flush = function(flushSource) {
    this.trigger('done', flushSource);
};

/**
 * A Stream that can combine multiple streams (ie. audio & video)
 * into a single output segment for MSE. Also supports audio-only
 * and video-only streams.
 */
CoalesceStream = function(options, metadataStream) {
    // Number of Tracks per output segment
    // If greater than 1, we combine multiple
    // tracks into a single segment
    this.numberOfTracks = 0;
    this.metadataStream = metadataStream;

    if (typeof options.remux !== 'undefined') {
        this.remuxTracks = !!options.remux;
    } else {
        this.remuxTracks = true;
    }

    this.pendingTracks = [];
    this.videoTrack = null;
    this.pendingBoxes = [];
    this.pendingCaptions = [];
    this.pendingMetadata = [];
    this.pendingBytes = 0;
    this.emittedTracks = 0;

    CoalesceStream.prototype.init.call(this);

    // Take output from multiple
    this.push = function(output) {
        // buffer incoming captions until the associated video segment
        // finishes
        if (output.text) {
            return this.pendingCaptions.push(output);
        }
        // buffer incoming id3 tags until the final flush
        if (output.frames) {
            return this.pendingMetadata.push(output);
        }

        // Add this track to the list of pending tracks and store
        // important information required for the construction of
        // the final segment
        this.pendingTracks.push(output.track);
        this.pendingBoxes.push(output.boxes);
        this.pendingBytes += output.boxes.byteLength;

        if (output.track.type === 'video') {
            this.videoTrack = output.track;
        }
        if (output.track.type === 'audio') {
            this.audioTrack = output.track;
        }
    };
};

// constants
var AUDIO_PROPERTIES = [
    'audioobjecttype',
    'channelcount',
    'samplerate',
    'samplingfrequencyindex',
    'samplesize'
];

var VIDEO_PROPERTIES = [
    'width',
    'height',
    'profileIdc',
    'levelIdc',
    'profileCompatibility'
];

CoalesceStream.prototype = new Stream();
CoalesceStream.prototype.flush = function(flushSource) {
    var
        offset = 0,
        event = {
            captions: [],
            metadata: [],
            info: {}
        },
        caption,
        id3,
        initSegment,
        timelineStartPts = 0,
        i;

    if (this.pendingTracks.length < this.numberOfTracks) {
        if (flushSource !== 'VideoSegmentStream' &&
            flushSource !== 'AudioSegmentStream') {
            // Return because we haven't received a flush from a data-generating
            // portion of the segment (meaning that we have only recieved meta-data
            // or captions.)
            return;
        } else if (this.remuxTracks) {
            // Return until we have enough tracks from the pipeline to remux (if we
            // are remuxing audio and video into a single MP4)
            return;
        } else if (this.pendingTracks.length === 0) {
            // In the case where we receive a flush without any data having been
            // received we consider it an emitted track for the purposes of coalescing
            // `done` events.
            // We do this for the case where there is an audio and video track in the
            // segment but no audio data. (seen in several playlists with alternate
            // audio tracks and no audio present in the main TS segments.)
            this.emittedTracks++;

            if (this.emittedTracks >= this.numberOfTracks) {
                this.trigger('done');
                this.emittedTracks = 0;
            }
            return;
        }
    }

    if (this.videoTrack) {
        timelineStartPts = this.videoTrack.timelineStartInfo.pts;
        VIDEO_PROPERTIES.forEach(function(prop) {
            event.info[prop] = this.videoTrack[prop];
        }, this);
    } else if (this.audioTrack) {
        timelineStartPts = this.audioTrack.timelineStartInfo.pts;
        AUDIO_PROPERTIES.forEach(function(prop) {
            event.info[prop] = this.audioTrack[prop];
        }, this);
    }

    if (this.pendingTracks.length === 1) {
        event.type = this.pendingTracks[0].type;
    } else {
        event.type = 'combined';
    }

    this.emittedTracks += this.pendingTracks.length;

    initSegment = mp4InitSegment(this.pendingTracks);

    // Create a new typed array large enough to hold the init
    // segment and all tracks
    event.data = new Uint8Array(initSegment.byteLength +
        this.pendingBytes);

    // Create an init segment containing a moov
    // and track definitions
    event.data.set(initSegment);
    offset += initSegment.byteLength;

    // Append each moof+mdat (one per track) after the init segment
    for (i = 0; i < this.pendingBoxes.length; i++) {
        event.data.set(this.pendingBoxes[i], offset);
        offset += this.pendingBoxes[i].byteLength;
    }

    // Translate caption PTS times into second offsets into the
    // video timeline for the segment
    for (i = 0; i < this.pendingCaptions.length; i++) {
        caption = this.pendingCaptions[i];
        caption.startTime = (caption.startPts - timelineStartPts);
        caption.startTime /= 90e3;
        caption.endTime = (caption.endPts - timelineStartPts);
        caption.endTime /= 90e3;
        event.captions.push(caption);
    }

    // Translate ID3 frame PTS times into second offsets into the
    // video timeline for the segment
    for (i = 0; i < this.pendingMetadata.length; i++) {
        id3 = this.pendingMetadata[i];
        id3.cueTime = (id3.pts - timelineStartPts);
        id3.cueTime /= 90e3;
        event.metadata.push(id3);
    }
    // We add this to every single emitted segment even though we only need
    // it for the first
    event.metadata.dispatchType = this.metadataStream.dispatchType;

    // Reset stream state
    this.pendingTracks.length = 0;
    this.videoTrack = null;
    this.pendingBoxes.length = 0;
    this.pendingCaptions.length = 0;
    this.pendingBytes = 0;
    this.pendingMetadata.length = 0;

    // Emit the built segment
    this.trigger('data', event);

    // Only emit `done` if all tracks have been flushed and emitted
    if (this.emittedTracks >= this.numberOfTracks) {
        this.trigger('done');
        this.emittedTracks = 0;
    }
};
