const View = require('./remoteView');

document.getElementById('run').addEventListener("click", function() {
  const view = new View();

  view.mount({
    elementId: 'container',
    logCallback: function(state, message) { }
  });
});
