// Loads the game, or a diagnostic page:
//   ?probe   — the lightest 3D page with a timer (can the device keep 3D running?)
//   ?padtest — shows everything the controller sends (how does this browser handle it?)
const params = new URLSearchParams(location.search);
if (params.has('probe')) void import('./probe');
else if (params.has('padtest')) void import('./padtest');
else void import('./main');

export {};
