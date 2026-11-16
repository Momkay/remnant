// Checks WebGL 2 before loading the piece, so an unsupported browser gets the calm page, not a console error.
if (document.createElement('canvas').getContext('webgl2')) {
  import('./main.js').catch((e) => {
    console.error('soot failed to start:', e);
    document.getElementById('statement').textContent = 'Something went wrong while loading. Reload the page.';
    for (const id of ['btn-a', 'btn-b', 'note']) document.getElementById(id).hidden = true;
  });
} else {
  document.getElementById('statement').textContent = 'This piece needs WebGL 2. Try a current Chrome, Edge, Firefox or Safari.';
  for (const id of ['btn-a', 'btn-b', 'note']) document.getElementById(id).hidden = true;
}
