
// The flow(flv live over websocket) objects.
// @see http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf
// @see https://github.com/winlinvip/videojs-flow
var FlowReader, FlowTag, FlowCodec, FlowGop, FlowTransmuxer;

// manage a gop of tags.
FlowGop = function() {
    var self = this;
    self.tags = [];
    self.nbKeyframes = 0;

    self.push = function(tag) {
        if (tag.isKeyframe()) {
            self.nbKeyframes++;
        }
        self.tags.push(tag);
    };

    self.pop = function() {
        if (self.nbKeyframes < 2) {
            return null;
        }

        var nbKeyframes = 0;
        var tags = [];
        while (self.tags.length > 0) {
            var tag = self.tags[0];

            if (tag.isKeyframe()) {
                // return one gop.
                if (nbKeyframes > 0) {
                    break;
                }

                self.nbKeyframes--;
                nbKeyframes++;
            }

            tags.push(self.tags.shift());
        }

        return tags;
    };
};

// convert flv to adts for aac or annexb for avc.
FlowCodec = function() {
    // set to the zero to reserved, for array map.
    var SrsCodecVideoAVCFrameReserved = 0,
        SrsCodecVideoAVCFrameReserved1 = 6,
        SrsCodecVideoAVCFrameKeyFrame = 1,
        SrsCodecVideoAVCFrameInterFrame= 2,
        SrsCodecVideoAVCFrameDisposableInterFrame = 3,
        SrsCodecVideoAVCFrameGeneratedKeyFrame = 4,
        SrsCodecVideoAVCFrameVideoInfoFrame = 5;

    // Table 1.1 - Audio Object Type definition
    // @see @see aac-mp4a-format-ISO_IEC_14496-3+2001.pdf, page 23
    var SrsAacObjectTypeReserved = 0,
        SrsAacObjectTypeAacMain = 1,
        SrsAacObjectTypeAacLC = 2,
        SrsAacObjectTypeAacSSR = 3,
        SrsAacObjectTypeAacHE = 5, // AAC HE = LC+SBR
        SrsAacObjectTypeAacHEV2 = 29; // AAC HEv2 = LC+SBR+PS

    /**
     * the avc payload format, must be ibmf or annexb format.
     * we guess by annexb first, then ibmf for the first time,
     * and we always use the guessed format for the next time.
     */
    var SrsAvcPayloadFormatGuess = 0,
        SrsAvcPayloadFormatAnnexb = 1,
        SrsAvcPayloadFormatIbmf = 2;

    /**
     * Table 7-1 - NAL unit type codes, syntax element categories, and NAL unit type classes
     * H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 83.
     */
    var SrsAvcNaluTypeReserved = 0,
        SrsAvcNaluTypeNonIDR = 1,
        SrsAvcNaluTypeDataPartitionA = 2,
        SrsAvcNaluTypeDataPartitionB = 3,
        SrsAvcNaluTypeDataPartitionC = 4,
        SrsAvcNaluTypeIDR = 5,
        SrsAvcNaluTypeSEI = 6,
        SrsAvcNaluTypeSPS = 7,
        SrsAvcNaluTypePPS = 8,
        SrsAvcNaluTypeAccessUnitDelimiter = 9,
        SrsAvcNaluTypeEOSequence = 10,
        SrsAvcNaluTypeEOStream = 11,
        SrsAvcNaluTypeFilterData = 12,
        SrsAvcNaluTypeSPSExt = 13,
        SrsAvcNaluTypePrefixNALU = 14,
        SrsAvcNaluTypeSubsetSPS = 15,
        SrsAvcNaluTypeLayerWithoutPartition = 19,
        SrsAvcNaluTypeCodedSliceExt = 20;

    // @see 7.1 Profiles, aac-iso-13818-7.pdf, page 40
    var SrsAacProfileMain = 0,
        SrsAacProfileLC = 1,
        SrsAacProfileSSR = 2,
        SrsAacProfileReserved = 3;

    var self = this;
    self.aac = {
        ok: false,
        object: 0, // SrsAacObjectType
        sampleRate: 0,
        channels: 0,
    };
    self.avc = {
        ok: false,
        profile: 0, // SrsAvcProfile
        level: 0, // SrsAvcLevel
        naluSize: 0,
        sps: null,
        pps: null,
        payload_format: SrsAvcPayloadFormatGuess,
    };

    // @see srs_codec_aac_rtmp2ts
    self.aac_rtmp2ts = function(object_type) {
        switch (object_type) {
            case SrsAacObjectTypeAacMain: return SrsAacProfileMain;
            case SrsAacObjectTypeAacHE:
            case SrsAacObjectTypeAacHEV2:
            case SrsAacObjectTypeAacLC: return SrsAacProfileLC;
            case SrsAacObjectTypeAacSSR: return SrsAacProfileSSR;
            default: return SrsAacProfileReserved;
        }
    };

    // aac audio to adts format for AdtsStream:
    //      toAdts(tag FlvTag) (frame Uint8Array)
    // @return null if not got adts frame.
    // @see SrsAacEncoder::write_audio
    self.toAdts = function(tag) {
        // for audio, pts equals to dts.
        tag.pts = tag.dts;

        var buf = tag.tag;
        if (buf.byteLength < 2) {
            throw new Error("audio tag invalid, size=" + buf.byteLength);
        }

        // @see: E.4.2 Audio Tags, video_file_format_spec_v10_1.pdf, page 76
        var sound_format = buf[0];
        // @see: SrsAvcAacCodec::audio_aac_demux
        //int8_t sound_type = sound_format & 0x01;
        //int8_t sound_size = (sound_format >> 1) & 0x01;
        //int8_t sound_rate = (sound_format >> 2) & 0x03;
        sound_format = (sound_format >> 4) & 0x0f;
        //     10 = AAC
        if (sound_format != 10) {
            throw new Error("audio is not aac, format=" + sound_format);
        }

        var aac_packet_type = buf[1];
        buf = buf.subarray(2);
        if (aac_packet_type == 0) {
            // AudioSpecificConfig
            // 1.6.2.1 AudioSpecificConfig, in aac-mp4a-format-ISO_IEC_14496-3+2001.pdf, page 33.
            //
            // only need to decode the first 2bytes:
            // audioObjectType, 5bits.
            // samplingFrequencyIndex, aac_sample_rate, 4bits.
            // channelConfiguration, aac_channels, 4bits
            if (buf.byteLength < 2) {
                throw new Error("aac sequence header invalid, size=" + buf.byteLength);
            }

            var audioObjectType = buf[0];
            self.aac.sampleRate = buf[1];

            self.aac.channels = (self.aac.sampleRate >> 3) & 0x0f;
            self.aac.sampleRate = ((audioObjectType << 1) & 0x0e) | ((self.aac.sampleRate >> 7) & 0x01);

            self.aac.object = (audioObjectType >> 3) & 0x1f;
            self.aac.ok = true;
            return null;
        }

        if (!self.aac.ok) {
            throw new Error("no aac sequence header");
        }

        // the left is the aac raw frame data.
        var aac_raw_length = buf.byteLength;

        // write the ADTS header.
        // @see aac-mp4a-format-ISO_IEC_14496-3+2001.pdf, page 75,
        //      1.A.2.2 Audio_Data_Transport_Stream frame, ADTS
        // @see https://github.com/ossrs/srs/issues/212#issuecomment-64145885
        // byte_alignment()

        // adts_fixed_header:
        //      12bits syncword,
        //      16bits left.
        // adts_variable_header:
        //      28bits
        //      12+16+28=56bits
        // adts_error_check:
        //      16bits if protection_absent
        //      56+16=72bits
        // if protection_absent:
        //      require(7bytes)=56bits
        // else
        //      require(9bytes)=72bits
        var aac_fixed_header = new Uint8Array(7);
        var aac_frame_length = aac_raw_length + 7;

        // Syncword 12 bslbf
        aac_fixed_header[0] = 0xff;
        // 4bits left.
        // adts_fixed_header(), 1.A.2.2.1 Fixed Header of ADTS
        // ID 1 bslbf
        // Layer 2 uimsbf
        // protection_absent 1 bslbf
        aac_fixed_header[1] = 0xf1;

        // profile 2 uimsbf
        // sampling_frequency_index 4 uimsbf
        // private_bit 1 bslbf
        // channel_configuration 3 uimsbf
        // original/copy 1 bslbf
        // home 1 bslbf
        var aac_profile = self.aac_rtmp2ts(self.aac.object);
        aac_fixed_header[2] = ((aac_profile << 6) & 0xc0) | ((self.aac.sampleRate << 2) & 0x3c) | ((self.aac.channels >> 2) & 0x01);
        // 4bits left.
        // adts_variable_header(), 1.A.2.2.2 Variable Header of ADTS
        // copyright_identification_bit 1 bslbf
        // copyright_identification_start 1 bslbf
        aac_fixed_header[3] = ((self.aac.channels << 6) & 0xc0) | ((aac_frame_length >> 11) & 0x03);

        // aac_frame_length 13 bslbf: Length of the frame including headers and error_check in bytes.
        // use the left 2bits as the 13 and 12 bit,
        // the aac_frame_length is 13bits, so we move 13-2=11.
        aac_fixed_header[4] = aac_frame_length >> 3;
        // adts_buffer_fullness 11 bslbf
        aac_fixed_header[5] = (aac_frame_length << 5) & 0xe0;

        // no_raw_data_blocks_in_frame 2 uimsbf
        aac_fixed_header[6] = 0xfc;

        var adts = new Uint8Array(aac_frame_length);
        adts.set(aac_fixed_header);
        adts.set(buf, 7);
        return adts;
    };

    // avc video to annexb format for NalByteStream:
    //      toAdts(tag FlvTag) (frame Uint8Array)
    self.toAnnexb = function(tag) {
        var buf = tag.tag;
        if (buf.byteLength < 5) {
            throw new Error("video tag invalid, size=" + buf.byteLength);
        }

        // @see: E.4.3 Video Tags, video_file_format_spec_v10_1.pdf, page 78
        var frame_type = buf[0];
        var codec_id = frame_type & 0x0f;
        frame_type = (frame_type >> 4) & 0x0f;

        // video sample, contains all NALUs in frame.
        var sample = {ok:false, frame_type:frame_type, size:tag.tag.byteLength,
            dts:tag.dts, cts:0, pts:0, avc_packet_type:0, nalus:[], has_idr:false,
            addNalu: function(nalu) {
                var nal_unit_type = (nalu[0] & 0x1f);
                if (nal_unit_type == SrsAvcNaluTypeIDR) {
                    this.has_idr = true;
                }
                //console.log("got nalu " + nalu.byteLength);
                this.nalus.push(nalu);
            },
        };
        // ignore info frame without error,
        // @see https://github.com/ossrs/srs/issues/288#issuecomment-69863909
        if (sample.frame_type == SrsCodecVideoAVCFrameVideoInfoFrame) {
            return null;
        }

        // only support h.264/avc
        if (codec_id != 7) {
            throw new Error("only support avc, actual=" + codec_id);
        }
        var avc_packet_type = buf[1];
        var composition_time = (buf[2]<<16)|(buf[3]<<8)|(buf[4]);
        buf = buf.subarray(5);

        // pts = dts + cts.
        sample.cts = composition_time;
        sample.pts = sample.dts + sample.cts;
        // update tag pts.
        tag.pts = sample.pts;

        sample.avc_packet_type = avc_packet_type;
        if (sample.avc_packet_type == 0) { // SequenceHeader
            self.avc_demux_sps_pps(buf);
            /*console.log("sps/pps profile=" + self.avc.profile + ", level=" + self.avc.level
             + ", naluSize=" + self.avc.naluSize + ", sps=" + (self.avc.sps? self.avc.sps.byteLength:0)
             + ", pps=" + (self.avc.pps? self.avc.pps.byteLength:0));*/
            return null;
        } else if (sample.avc_packet_type == 1) { // NALU
            self.avc_demux_sample(buf, sample)
            if (!sample.ok) {
                return null;
            }
            return self.avc_transmux_sample(sample);
        }
        return null;
    };
    self.avc_demux_sps_pps = function(buf) {
        if (buf.byteLength < 5) {
            throw new Error("sps/pps invalid, size=" + buf.byteLength);
        }

        //int8_t configurationVersion = stream->read_1bytes();
        //int8_t AVCProfileIndication = stream->read_1bytes();
        self.avc.profile = buf[1];
        //int8_t profile_compatibility = stream->read_1bytes();
        //int8_t AVCLevelIndication = stream->read_1bytes();
        self.avc.level = buf[3];

        // parse the NALU size.
        self.avc.naluSize = (buf[4]&0x03); // lengthSizeMinusOne

        // 5.3.4.2.1 Syntax, H.264-AVC-ISO_IEC_14496-15.pdf, page 16
        // 5.2.4.1 AVC decoder configuration record
        // 5.2.4.1.2 Semantics
        // The value of this field shall be one of 0, 1, or 3 corresponding to a
        // length encoded with 1, 2, or 4 bytes, respectively.
        if (self.avc.naluSize == 2) {
            throw new Error("invalid nalu size=" + self.avc.naluSize);
        }
        buf = buf.subarray(5);

        // 1 sps, 7.3.2.1 Sequence parameter set RBSP syntax
        // H.264-AVC-ISO_IEC_14496-10.pdf, page 45.
        if (buf.byteLength < 3) {
            throw new Error("invalid sps, size=" + buf.byteLength);
        }
        var numOfSequenceParameterSets = buf[0]&0x1f;
        if (numOfSequenceParameterSets != 1) {
            throw new Error("invalid sps, count=" + numOfSequenceParameterSets);
        }
        var sequenceParameterSetLength = (buf[1]<<8)|(buf[2]);
        buf = buf.subarray(3);
        if (buf.byteLength < sequenceParameterSetLength) {
            throw new Error("invalid sps, require=" + sequenceParameterSetLength);
        }
        self.avc.sps = buf.subarray(0, sequenceParameterSetLength);
        buf = buf.subarray(sequenceParameterSetLength);

        // 1 pps
        if (buf.byteLength < 3) {
            throw new Error("invalid pps, size=" + buf.byteLength);
        }
        var numOfPictureParameterSets = buf[0]&0x1f;
        if (numOfPictureParameterSets != 1) {
            throw new Error("invalid pps, count=" + numOfPictureParameterSets);
        }
        var pictureParameterSetLength = (buf[1]<<8)|(buf[2]);
        buf = buf.subarray(3);
        if (buf.byteLength < pictureParameterSetLength) {
            throw new Error("invalid pps, require=" + pictureParameterSetLength);
        }
        self.avc.pps = buf.subarray(0, pictureParameterSetLength);
        buf = buf.subarray(pictureParameterSetLength);

        self.avc.ok = true;
    };
    self.avc_demux_sample = function(buf, sample) {
        if (!self.avc.ok) {
            throw new Error("drop for no sequence header");
        }

        // guess for the first time.
        if (self.avc.payload_format == SrsAvcPayloadFormatGuess) {
            // One or more NALUs (Full frames are required)
            // try  "AnnexB" from H.264-AVC-ISO_IEC_14496-10.pdf, page 211.
            if (!self.avc_demux_annexb_format(buf, sample)) {
                // try "ISO Base Media File Format" from H.264-AVC-ISO_IEC_14496-15.pdf, page 20
                if (!self.avc_demux_ibmf_format(buf, sample)) {
                    throw new Error("invalid format, not annexb or ibmf");
                } else {
                    self.avc.payload_format = SrsAvcPayloadFormatIbmf;
                }
            } else {
                self.avc.payload_format = SrsAvcPayloadFormatAnnexb;
            }
        } else if (self.avc.payload_format == SrsAvcPayloadFormatIbmf) {
            // try "ISO Base Media File Format" from H.264-AVC-ISO_IEC_14496-15.pdf, page 20
            if (!self.avc_demux_ibmf_format(buf, sample)) {
                throw new Error("invalid ibmf format.");
            }
        } else {
            // One or more NALUs (Full frames are required)
            // try  "AnnexB" from H.264-AVC-ISO_IEC_14496-10.pdf, page 211.
            if (!self.avc_demux_annexb_format(buf, sample)) {
                // try "ISO Base Media File Format" from H.264-AVC-ISO_IEC_14496-15.pdf, page 20
                if (!self.avc_demux_ibmf_format(buf, sample)) {
                    throw new Error("invalid format, not annexb or ibmf");
                } else {
                    self.avc.payload_format = SrsAvcPayloadFormatIbmf;
                }
            }
        }
    };
    self.avc_demux_annexb_format = function(buf, sample) {
        var srs_avc_startswith_annexb = function(buf) {
            var p = buf.subarray(0);
            for (;;) {
                if (p.byteLength < 3) {
                    return null;
                }

                // not match
                if (p[0] != 0x00 || p[1] != 0x00) {
                    return null;
                }

                // match N[00] 00 00 01, where N>=0
                if (p[2] == 0x01) {
                    return p;
                }

                p = p.subarray(1);
            }

            return null;
        }

        buf = srs_avc_startswith_annexb(buf);
        // not annexb, try others
        if (!buf) {
            return false;
        }

        // AnnexB
        // B.1.1 Byte stream NAL unit syntax,
        // H.264-AVC-ISO_IEC_14496-10.pdf, page 211.
        while (buf && buf.byteLength > 0) {
            var next = srs_avc_startswith_annexb(buf.subarray(1));
            var nalu = buf.subarray(3, buf.byteLength - (next? next.byteLength:0) - 3);
            sample.addNalu(nalu);
            buf = next;
        }

        sample.ok = true;
        return true;
    };
    self.avc_demux_ibmf_format = function(buf, sample) {
        while (buf && buf.byteLength > 0) {
            if (buf.byteLength < (self.avc.naluSize + 1)) {
                throw new Error("invalid nalu length, require=" + (self.avc.naluSize+1) + ", size=" + buf.byteLength);
            }
            var NALUnitLength = 0;
            if (self.avc.naluSize == 3) {
                NALUnitLength = (buf[0]<<24)|(buf[1]<<16)|(buf[2]<<8)|(buf[3]);
            } else if (self.avc.naluSize == 1) {
                NALUnitLength = (buf[0]<<8)|(buf[1]);
            } else {
                NALUnitLength = buf[0];
            }
            buf = buf.subarray(self.avc.naluSize + 1);

            // maybe stream is invalid format.
            // see: https://github.com/ossrs/srs/issues/183
            if (NALUnitLength < 0) {
                return false;
            }

            // NALUnit
            if (buf.byteLength < NALUnitLength) {
                throw new Error("invalid nalu, require=" + NALUnitLength + ", size=" + buf.byteLength);
            }
            // 7.3.1 NAL unit syntax, H.264-AVC-ISO_IEC_14496-10.pdf, page 44.
            var nalu = buf.subarray(0, NALUnitLength);
            sample.addNalu(nalu);
            buf = buf.subarray(NALUnitLength);
        }

        sample.ok = true;
        return true;
    };
    self.avc_transmux_sample = function(sample) {
        /*console.log("avc(profile=" + self.avc.profile + ", level=" + self.avc.level
         + ", naluSize=" + self.avc.naluSize + ", sps=" + self.avc.sps.byteLength
         + ", pps=" + self.avc.pps.byteLength + ") frame type=" + sample.frame_type
         + ", size=" + sample.size + ", dts=" + sample.dts + ", pts=" + sample.pts
         + ", nalus=" + sample.nalus.length + ", idr=" + sample.has_idr);*/

        // mux the samples in annexb format,
        // H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 324.
        /**
         * 00 00 00 01 // header
         *       xxxxxxx // data bytes
         * 00 00 01 // continue header
         *       xxxxxxx // data bytes.
         *
         * nal_unit_type specifies the type of RBSP data structure contained in the NAL unit as specified in Table 7-1.
         * Table 7-1 - NAL unit type codes, syntax element categories, and NAL unit type classes
         * H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 83.
         *      1, Coded slice of a non-IDR picture slice_layer_without_partitioning_rbsp( )
         *      2, Coded slice data partition A slice_data_partition_a_layer_rbsp( )
         *      3, Coded slice data partition B slice_data_partition_b_layer_rbsp( )
         *      4, Coded slice data partition C slice_data_partition_c_layer_rbsp( )
         *      5, Coded slice of an IDR picture slice_layer_without_partitioning_rbsp( )
         *      6, Supplemental enhancement information (SEI) sei_rbsp( )
         *      7, Sequence parameter set seq_parameter_set_rbsp( )
         *      8, Picture parameter set pic_parameter_set_rbsp( )
         *      9, Access unit delimiter access_unit_delimiter_rbsp( )
         *      10, End of sequence end_of_seq_rbsp( )
         *      11, End of stream end_of_stream_rbsp( )
         *      12, Filler data filler_data_rbsp( )
         *      13, Sequence parameter set extension seq_parameter_set_extension_rbsp( )
         *      14, Prefix NAL unit prefix_nal_unit_rbsp( )
         *      15, Subset sequence parameter set subset_seq_parameter_set_rbsp( )
         *      19, Coded slice of an auxiliary coded picture without partitioning slice_layer_without_partitioning_rbsp( )
         *      20, Coded slice extension slice_layer_extension_rbsp( )
         * the first ts message of apple sample:
         *      annexb 4B header, 2B aud(nal_unit_type:6)(0x09 0xf0)
         *      annexb 4B header, 19B sps(nal_unit_type:7)
         *      annexb 3B header, 4B pps(nal_unit_type:8)
         *      annexb 3B header, 12B nalu(nal_unit_type:6)
         *      annexb 3B header, 21B nalu(nal_unit_type:6)
         *      annexb 3B header, 2762B nalu(nal_unit_type:5)
         *      annexb 3B header, 3535B nalu(nal_unit_type:5)
         * the second ts message of apple ts sample:
         *      annexb 4B header, 2B aud(nal_unit_type:6)(0x09 0xf0)
         *      annexb 3B header, 21B nalu(nal_unit_type:6)
         *      annexb 3B header, 379B nalu(nal_unit_type:1)
         *      annexb 3B header, 406B nalu(nal_unit_type:1)
         */
        var fresh_nalu_header = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
        var cont_nalu_header = new Uint8Array([0x00, 0x00, 0x01]);

        // the aud(access unit delimiter) before each frame.
        // 7.3.2.4 Access unit delimiter RBSP syntax
        // H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 66.
        //
        // primary_pic_type u(3), the first 3bits, primary_pic_type indicates that the slice_type values
        //      for all slices of the primary coded picture are members of the set listed in Table 7-5 for
        //      the given value of primary_pic_type.
        //      0, slice_type 2, 7
        //      1, slice_type 0, 2, 5, 7
        //      2, slice_type 0, 1, 2, 5, 6, 7
        //      3, slice_type 4, 9
        //      4, slice_type 3, 4, 8, 9
        //      5, slice_type 2, 4, 7, 9
        //      6, slice_type 0, 2, 3, 4, 5, 7, 8, 9
        //      7, slice_type 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
        // 7.4.2.4 Access unit delimiter RBSP semantics
        // H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 102.
        //
        // slice_type specifies the coding type of the slice according to Table 7-6.
        //      0, P (P slice)
        //      1, B (B slice)
        //      2, I (I slice)
        //      3, SP (SP slice)
        //      4, SI (SI slice)
        //      5, P (P slice)
        //      6, B (B slice)
        //      7, I (I slice)
        //      8, SP (SP slice)
        //      9, SI (SI slice)
        // H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 105.
        var aud_nalu_7 = new Uint8Array([0x09, 0xf0]);

        // always append a aud nalu for each frame.
        var frameSize = 4+2+ 4+self.avc.sps.byteLength+ 3+self.avc.pps.byteLength;
        for (var i in sample.nalus) {
            var nalu = sample.nalus[i];
            frameSize += 3+nalu.byteLength;
        }
        var frame = new Uint8Array(frameSize);
        frameSize = 0;

        // aud.
        frame.set(fresh_nalu_header, frameSize); frameSize += 4;
        frame.set(aud_nalu_7, frameSize); frameSize += 2;

        // when ts message(samples) contains IDR, insert sps+pps.
        if (sample.has_idr) {
            // fresh nalu header before sps.
            if (self.avc.sps.byteLength > 0) {
                // AnnexB prefix, for sps always 4 bytes header
                frame.set(fresh_nalu_header, frameSize); frameSize += 4;
                // sps
                frame.set(self.avc.sps, frameSize); frameSize += self.avc.sps.byteLength;
            }
            // cont nalu header before pps.
            if (self.avc.pps.byteLength > 0) {
                // AnnexB prefix, for pps always 3 bytes header
                frame.set(cont_nalu_header, frameSize); frameSize += 3;
                // pps
                frame.set(self.avc.pps, frameSize); frameSize += self.avc.pps.byteLength;
            }
        }

        // all sample use cont nalu header, except the sps-pps before IDR frame.
        for (var i in sample.nalus) {
            var nalu = sample.nalus[i];

            // 5bits, 7.3.1 NAL unit syntax,
            // H.264-AVC-ISO_IEC_14496-10-2012.pdf, page 83.
            var nal_unit_type = nalu[0]&0x1f;

            // ignore SPS/PPS/AUD
            switch (nal_unit_type) {
                case SrsAvcNaluTypeSPS:
                case SrsAvcNaluTypePPS:
                case SrsAvcNaluTypeAccessUnitDelimiter:
                    continue;
                default:
                    break;
            }

            // insert cont nalu header before frame.
            frame.set(cont_nalu_header, frameSize); frameSize += 3;
            // sample data
            frame.set(nalu, frameSize); frameSize += nalu.byteLength;
        }

        //console.log(frame.byteLength + ", " + frameSize);
        var annexb = frame.subarray(0, frameSize);
        return annexb;
    };
};

// the flv tag data.
FlowTag = function() {
    var self = this;
    self.type = self.dts = self.pts = 0; // uint
    self.tag = null; // Uint8Array.

    self.isAudio = function() {
        return self.type == 8;
    }
    self.isVideo = function () {
        return self.type == 9;
    };
    self.isKeyframe = function() {
        if (!self.isVideo()) {
            return false;
        }

        if (self.tag.byteLength < 1) {
            throw new Error("invalid keyframe, size=" + self.tag.byteLength);
        }

        // @see: E.4.3 Video Tags, video_file_format_spec_v10_1.pdf, page 78
        var frame_type = self.tag[0];
        frame_type = (frame_type >> 4) & 0x0f;

        var SrsCodecVideoAVCFrameKeyFrame = 1;
        return frame_type == SrsCodecVideoAVCFrameKeyFrame;
    };
    self.isAac = function() {
        if (self.tag.byteLength < 1) {
            throw new Error("invalid aac frame, size=" + self.tag.byteLength);
        }

        var sound_format = (self.tag[0]>>4)&0x0f;
        return sound_format == 10;
    };
    self.isAvc = function() {
        if (self.tag.byteLength < 1) {
            throw new Error("invalid avc frame, size=" + self.tag.byteLength);
        }

        var codec_id = (self.tag[0]&0x0f);
        return codec_id == 7;
    };
    self.isSequenceHeader = function() {
        if (self.isAudio()) {
            if (!self.isAac()) {
                return false;
            }

            if (self.tag.byteLength < 1) {
                throw new Error("invalid aac sh, size=" + self.tag.byteLength);
            }

            var aacPacketType = self.tag[1];
            return aacPacketType == 0;
        }

        if (!self.isVideo()) {
            return false;
        }

        if (self.tag.byteLength < 1) {
            throw new Error("invalid avc sh, size=" + self.tag.byteLength);
        }

        var avcPacktType = self.tag[1];
        return avcPacktType == 0;
    };
    self.isScriptData = function() {
        return self.type == 18;
    };
    self.toString = function() {
        var t = self.isAudio()? "Audio":self.isVideo()? "Video": self.isScriptData()? "Data":"Other";
        return t + ', ' + Number(Number(self.dts)/1000).toFixed(2) + 's, ' + self.tag.byteLength + ' bytes';
    };
};

// read FlvTag from Uint8Array.
FlowReader = function() {
    var self = this;
    self.header = {
        ok: false,
        version: 0, // File version (for example, 0x01 for FLV version 1)
        hasAudio: false, // 1 = Audio tags are present
        hasVideo: false, // 1 = Video tags are present
    };
    self.sequenceHeader = null;
    self.cache = null;

    // append bytes to reader:
    //      append(ibytes Uint8Array) void
    self.append = function(ibytes) {
        var everything;
        if (self.cache && self.cache.byteLength > 0) {
            everything = new Uint8Array(self.cache.byteLength + ibytes.byteLength);
            everything.set(self.cache);
            everything.set(ibytes, self.cache.byteLength);
        } else {
            everything = ibytes;
        }

        self.cache = everything;
    };

    // read FlvTag instance from reader.
    //      read() (tag FlvTag)
    // @return null if eof, user should append bytes then parse.
    self.read = function(){
        var everything = self.cache;
        if (!everything) {
            return null;
        }

        while(true) {
            if (everything.byteLength < 11) {
                return null;
            }

            // parse flv header id: FLV.
            if (!self.header.ok && everything[0] == 0x46 && everything[1] == 0x4C && everything[2] == 0x56) {
                if (everything.byteLength < 13) {
                    return null;
                }
                self.header.ok = true;
                self.header.hasAudio = ((everything[4]&0x40) == 0x40);
                self.header.hasVideo = ((everything[4]&0x01) == 0x01);
                self.cache = everything = everything.subarray(13);
                continue;
            }

            // parse a tag from bytes.
            var obj = new FlowTag();
            obj.type = everything[0]&0x1f;
            var size = (everything[1]<<16)|(everything[2]<<8)|(everything[3]);
            obj.dts = (everything[7]<<24)|(everything[4]<<16)|(everything[5]<<8)|(everything[6]);
            if (everything.byteLength < 11 + size + 4) {
                return null;
            }
            obj.tag = everything.subarray(11, 11 + size);

            var index = 11 + size + 4; // 11:tag-header, size:tag, 4:previous-tag-size.
            self.cache = everything.subarray(index);
            var pps = (everything[index-4]<<24)|(everything[index-3]<<16)
                |(everything[index-2]<<8)|(everything[index-1]);
            if (obj.type != 8 && obj.type != 9 && obj.type != 18) {
                throw new Error("invalid type=" + obj.type);
            }
            if (pps != size+11) {
                throw new Error("invalid pps=" + pps + ", size=" + size);
            }
            if (obj.dts < 0) {
                throw new Error("invalid dts=" + obj.dts);
            }

            return obj;
        }

        return null;
    };
};

/**
 * A Stream that expects MP2T binary data as input and produces
 * corresponding media segments, suitable for use with Media Source
 * Extension (MSE) implementations that support the ISO BMFF byte
 * stream format, like Chrome.
 */
FlowTransmuxer = function() {
    var self = this;
    self.flv = new FlowReader();
    self.codec = new FlowCodec();
    self.gop = new FlowGop();
    self.ws = null; // WebSocket

    var videoTrack = {type:'video',codec:'avc',timelineStartInfo:{baseMediaDecodeTime:0}};
    var audioTrack = {type:'audio',codec:'adts',timelineStartInfo:{baseMediaDecodeTime:0}};

    var pipeline = {};
    pipeline.type = 'flow'; // FLOW(flv live over websocet), annexb to mp4.
    pipeline.h264Stream = new muxjs.codecs.h264.H264Stream();
    pipeline.adtsStream = new muxjs.codecs.adts(); // new AdtsStream()
    pipeline.videoSegmentStream = new muxjs.mp4.VideoSegmentStream(videoTrack);
    pipeline.audioSegmentStream = new muxjs.mp4.AudioSegmentStream(audioTrack);
    pipeline.coalesceStream = new CoalesceStream({}, {dispatchType:muxjs.mp2t.METADATA_STREAM_TYPE});
    pipeline.h264Stream
        .pipe(pipeline.videoSegmentStream)
        .pipe(pipeline.coalesceStream);
    pipeline.adtsStream
        .pipe(pipeline.audioSegmentStream)
        .pipe(pipeline.coalesceStream);

    FlowTransmuxer.prototype.init.call(this);

    // append mp4 segment to mse.
    pipeline.coalesceStream.on('data', function(segment){
        //console.log('append mp4 ' + segment.type + " " + segment.data.buffer.byteLength + " bytes");
        self.trigger('data', segment);
    });

    self.src = function(url) {
        self.ws = new WebSocket(url);
        self.ws.onmessage = function(evt) {
            var b = evt.data; // Blob: https://developer.mozilla.org/en-US/docs/Web/API/Blob
            var reader = new FileReader();
            reader.addEventListener('loadend', function(){
                var bytes = new Uint8Array(reader.result);
                self.transmux(bytes);
            });
            reader.readAsArrayBuffer(b);
        };
    };

    // flv => tag => annexb/adts => mp4 => mse.
    self.transmux = function(bytes) {
        self.flv.append(bytes);

        while (true) {
            var tag = self.flv.read();
            if (!tag) {
                break;
            }

            if (tag.isSequenceHeader()) {
                if (tag.isAudio()) {
                    self.codec.toAdts(tag);
                    //console.log("parse audio sequence header");
                } else {
                    self.codec.toAnnexb(tag);
                    //console.log("parse video sequence header");
                }
                continue;
            }

            // append to the gop and conusme it.
            self.gop.push(tag);
            while (self.consumeGop()) {
            }
        }
    };
    // parse a gop of tags to mp4.
    self.consumeGop = function() {
        // when got one complete gop, transmux it.
        var tags = self.gop.pop();
        if (!tags) {
            return false;
        }
        var first = tags[0];
        var last = tags[tags.length - 1];
        /*console.log("parse gop " + tags.length + " tags, dts[" + first.dts
         + "," + last.dts + "], duration=" + (last.dts - first.dts));*/

        // parse all tags.
        for (var i in tags) {
            var tag = tags[i];

            if (tag.isAudio()) {
                var frame = self.codec.toAdts(tag);
                if (!frame) {
                    continue;
                }
                //console.log("adts " + frame.byteLength + " bytes");

                // @remark we must use ts tbn(*90 for flv).
                pipeline.adtsStream.push({type:'audio', trackId:100, dts:tag.dts*90, pts:tag.pts*90, data:frame,});
            } else if(tag.isVideo()) {
                var frame = self.codec.toAnnexb(tag);
                if (!frame) {
                    continue;
                }
                //console.log("annexb " + frame.byteLength + " bytes");

                // @remark we must use ts tbn(*90 for flv).
                pipeline.h264Stream.push({type:'video', trackId:101, dts:tag.dts*90, pts:tag.pts*90, data:frame,});
            }
        }

        pipeline.h264Stream.flush();
        pipeline.adtsStream.flush();

        return true;
    };
};

FlowTransmuxer.prototype = new Stream();
