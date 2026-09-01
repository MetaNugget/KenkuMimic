const WebSocket = require('ws');

// Promise-wraps a WebSocket's connection lifecycle: resolves once open,
// rejects on an error before that. After opening, later errors go to
// onError instead of rejecting an already-settled promise.
function connectWebSocket(url, wsOptions, onError) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOptions);

    const onOpenError = (err) => reject(err);
    ws.once('error', onOpenError);
    ws.once('open', () => {
      ws.off('error', onOpenError);
      if (onError) ws.on('error', onError);
      resolve(ws);
    });
  });
}

module.exports = { connectWebSocket };
