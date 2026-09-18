/**
 * loader.js — dual-mode bootstrap for Electron and web
 *
 * Phase Web W.1 (Day 192): handles loading the game in both environments:
 * - Electron: window.bridge already exists (from preload.cjs)
 * - Web: load bridge-web.js first, then game.js
 */

// Detect environment: Electron has window.bridge set by preload.cjs
const isElectron = typeof window.bridge !== 'undefined';

if (isElectron) {
  // Electron path: bridge is already loaded by preload.cjs
  import('./src/game.js');
} else {
  // Web path: load bridge first, then game
  import('./src/bridge-web.js')
    .then(module => module.installBridge())
    .then(() => import('./src/game.js'))
    .catch(err => {
      console.error('Failed to initialize game:', err);
      const canvas = document.getElementById('game');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.font = '16px monospace';
        ctx.fillText('Failed to initialize game. Check console for details.', 20, 40);
      }
    });
}
