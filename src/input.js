/**
 * input.js — unified Input Manager.
 *
 * Keyboard, mouse and gamepad are all flattened into ABSTRACT ACTIONS
 * ("up", "fire", "pause", "slot3"...). Game code never asks "is W down?" —
 * it asks "is `up` down?". Benefits:
 *   - rebinding later is a data change, not a code change
 *   - a future netcode layer can feed remote players' actions through the
 *     exact same interface (the simulation only consumes actions)
 *
 * Edge detection: wasPressed(action) is true for exactly one simulation step
 * after the control goes down. Call update() at the start of each sim step
 * and endFrame() at the end.
 */

const KEY_BINDINGS = {
  // Movement (WASD + arrows)
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',

  // Combat / flow
  Space: 'fire',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyE: 'castA',
  KeyR: 'castB',
  Enter: 'confirm',
  Escape: 'pause',
  KeyP: 'pause',

  // Crafting
  KeyC: 'craft',   // debugForge: open forge; else toast / Offer skip
  Tab: 'craft',
  KeyQ: 'clear',   // cancel forge selection

  // Menu niceties
  KeyN: 'newSeed',
  KeyG: 'resetGenome',
  KeyV: 'genome',
  KeyM: 'mute',

  // Day 110 — Lab speed shortcuts (experienced players ≤30s)
  KeyX: 'labSkip',   // discard remaining Offers without leaving
  KeyF: 'labExit',   // skip leftover Offers + leave Lab immediately

  // Inventory slots 1-9
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3',
  Digit4: 'slot4', Digit5: 'slot5', Digit6: 'slot6',
  Digit7: 'slot7', Digit8: 'slot8', Digit9: 'slot9'
};

// Standard-mapping gamepad buttons -> actions.
const PAD_BUTTONS = {
  0: 'fire',     // A / Cross
  1: 'dash',     // B / Circle (Day 064 → castA via game layer)
  2: 'craft',    // X / Square
  3: 'clear',    // Y / Triangle
  4: 'castA',    // LB / L1
  5: 'castB',    // RB / R1
  9: 'pause',    // Start
  12: 'up', 13: 'down', 14: 'left', 15: 'right' // D-pad
};

const PAD_DEADZONE = 0.25;

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;

    this._down = new Set();     // actions currently held
    this._pressed = new Set();  // actions that went down since last endFrame()
    this._padPrev = new Set();  // pad buttons held last poll (for edges)

    // Raw mouse position in SCREEN pixels. The game layer converts this to
    // world coordinates through the viewport transform — the input manager
    // deliberately knows nothing about the camera.
    this.mouse = { x: canvas.width / 2, y: canvas.height / 2, down: false };

    this._padAim = null; // right-stick aim vector while the stick is deflected

    this._attach();
  }

  _attach() {
    window.addEventListener('keydown', (e) => {
      const action = KEY_BINDINGS[e.code];
      if (!action) return;
      e.preventDefault();
      this._press(action);
    });

    window.addEventListener('keyup', (e) => {
      const action = KEY_BINDINGS[e.code];
      if (action) this._down.delete(action);
    });

    // Mouse: position is the aim target, left button fires.
    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouse.down = true;
        this._press('fire');
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.mouse.down = false;
        this._down.delete('fire');
      }
    });

    // Don't let held keys "stick" when the window loses focus.
    window.addEventListener('blur', () => {
      this._down.clear();
      this.mouse.down = false;
    });

    // Right-click is reserved for future bindings — never the browser menu.
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _press(action) {
    if (!this._down.has(action)) this._pressed.add(action);
    this._down.add(action);
  }

  /**
   * Poll gamepads. Call once at the start of every simulation step.
   * (Keyboard/mouse are event-driven; pads must be polled.)
   */
  update() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);

    // Release pad-held actions that the keyboard isn't also holding.
    const padHeld = new Set();

    if (pad) {
      // Buttons -> actions with edge detection.
      for (const [index, action] of Object.entries(PAD_BUTTONS)) {
        if (pad.buttons[index]?.pressed) {
          padHeld.add(action);
          if (!this._padPrev.has(action)) this._press(action);
          else this._down.add(action);
        }
      }
      // Face button A doubles as "confirm" in menus.
      if (pad.buttons[0]?.pressed && !this._padPrev.has('confirm')) {
        this._press('confirm');
        padHeld.add('confirm');
      }

      // Left stick -> movement axis (read in axis()).
      this._padMove = {
        x: Math.abs(pad.axes[0]) > PAD_DEADZONE ? pad.axes[0] : 0,
        y: Math.abs(pad.axes[1]) > PAD_DEADZONE ? pad.axes[1] : 0
      };

      // Right stick -> aim (overrides mouse while deflected).
      const ax = pad.axes[2] ?? 0;
      const ay = pad.axes[3] ?? 0;
      if (Math.hypot(ax, ay) > PAD_DEADZONE) {
        this._padAim = { x: ax, y: ay };
        // Aiming with the stick implies wanting to shoot in twin-stick style.
        padHeld.add('fire');
        this._down.add('fire');
      } else {
        this._padAim = null; // stick released — mouse regains aim control
      }
    } else {
      this._padMove = null;
      this._padAim = null;
    }

    // Drop pad actions released this poll (but keep keyboard-held ones alive:
    // keyup events handle those independently).
    for (const action of this._padPrev) {
      if (!padHeld.has(action)) this._down.delete(action);
    }
    this._padPrev = padHeld;
  }

  /** Is the action currently held? */
  isDown(action) {
    return this._down.has(action);
  }

  /** Did the action go down since the last endFrame()? (one-shot) */
  wasPressed(action) {
    return this._pressed.has(action);
  }

  /** Normalized movement vector combining keys + left stick. */
  axis() {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let y = (this.isDown('down') ? 1 : 0) - (this.isDown('up') ? 1 : 0);

    if (this._padMove && (this._padMove.x || this._padMove.y)) {
      x = this._padMove.x;
      y = this._padMove.y;
    }

    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  /**
   * Normalized right-stick aim vector, or null while the stick is centered
   * (the game layer falls back to mouse aim in that case).
   */
  padAim() {
    if (!this._padAim) return null;
    const len = Math.hypot(this._padAim.x, this._padAim.y) || 1;
    return { x: this._padAim.x / len, y: this._padAim.y / len };
  }

  /** Which slot key (1-9) was pressed this step, or 0 for none. */
  pressedSlot() {
    for (let i = 1; i <= 9; i++) {
      if (this.wasPressed(`slot${i}`)) return i;
    }
    return 0;
  }

  /** Clear one-shot edges. Call at the END of each simulation step. */
  endFrame() {
    this._pressed.clear();
  }
}
