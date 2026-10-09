// Loads the game, or with ?probe a tiny test page for checking whether a
// device's browser can keep a simple 3D page running.
if (new URLSearchParams(location.search).has('probe')) void import('./probe');
else void import('./main');
