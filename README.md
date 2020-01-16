# videojs-flow

videojs-flow(flv live over websocket), low latency live streaming 
[plugin](https://github.com/videojs/video.js/wiki/Plugins) 
for [videojs](http://videojs.com/).

```
+---------------+       +----------------+       +--------------+        +----------------------+
| videojs(MSE)  +---<---+ videojs-flow   +---<---+ demo/mse.go  +--<-----+      Media Server    +
+---------------+       + (js flv2mp4)   +       + (http to ws) +        +   (http flv live)    +
                        +----------------+       +--------------+        +----------------------+
```

> Remark: Please use [bilibili/flv.js](https://github.com/Bilibili/flv.js#features) for videojs-flow.

## Usage

To check your browser whether support MSE, click [here](http://ossrs.net/mse/html5.html).

To start SRS with a live stream `http://localhost:8081/live/livestream.flv`, please read [here](https://github.com/ossrs/srs/wiki/v3_EN_SampleHttpFlv).

To run `demo/mse.go` to transmux HTTP-FLV to WebSocket-FLV `ws://localhost:8080/live/livestream.flv`:

```
go get golang.org/x/net/websocket &&
go run mse.go -l 8080 -b 8081
```

## Links

H5 capabilities:

1. http://ossrs.net/mse/html5.html

About Websocket:

1. https://tools.ietf.org/html/rfc6455
1. https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
1. https://en.wikipedia.org/wiki/WebSocket
1. http://caniuse.com/#search=websocket

About MSE(Media Source Extension):

1. https://www.w3.org/TR/media-source
1. https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
1. https://en.wikipedia.org/wiki/Media_Source_Extensions
1. http://caniuse.com/#feat=mediasource

About Videojs:

1. http://videojs.com/getting-started/
1. http://ossrs.net/mse/videojs.html

> Remark: The MSE(Chrome) requires segment starts with keyframe, read [videojs](https://github.com/winlinvip/mux.js/blob/master/lib/mp4/transmuxer.js#L319). 

Winlin 2016
