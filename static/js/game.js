"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID_RADIUS = 3;

// Axial neighbour offsets, indexed 0-5  (E, NE, NW, W, SW, SE)
const HEX_DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

// Canvas angles (radians) for each direction in a pointy-top hex grid
//  Dir 0 (E)  → 0°
//  Dir 1 (NE) → -60°  (upper-right in screen coords)
//  Dir 2 (NW) → -120°
//  Dir 3 (W)  → 180°
//  Dir 4 (SW) → 120°
//  Dir 5 (SE) → 60°
const DIR_ANGLES = [0, -Math.PI/3, -2*Math.PI/3, Math.PI, 2*Math.PI/3, Math.PI/3];

const COLORS = {
  bg:       "#0f172a",
  empty:    "#1e3a5f",
  emptyBdr: "rgba(255,255,255,0.1)",
  hover:    "rgba(251,191,36,0.35)",
  hoverBdr: "#fbbf24",
  capture:  "#10b981",
  p1:       "#3b82f6",
  p1dark:   "#1d4ed8",
  p2:       "#ef4444",
  p2dark:   "#b91c1c",
  arrow:    "rgba(255,255,255,0.92)",
  dot:      "rgba(255,255,255,0.55)",
  lastMove: "#fbbf24",
};

// ---------------------------------------------------------------------------
// Helper: piece directions
// ---------------------------------------------------------------------------
function pieceDirections(type, rotation) {
  if (type === 0) return [];
  const base = type === 2 ? [0, 3] : [0, 2, 4];
  return base.map(d => (d + rotation) % 6);
}

// ---------------------------------------------------------------------------
// HexGame class
// ---------------------------------------------------------------------------
class HexGame {
  constructor(gameId, playerId, mode) {
    this.gameId   = gameId;
    this.playerId = playerId; // "1" or "2"
    this.mode     = mode;     // "local" | "online"

    this.canvas = document.getElementById("board-canvas");
    this.ctx    = this.canvas.getContext("2d");

    this.state         = null;   // full game state from server
    this.selIndex      = -1;     // selected piece index (-1 = none)
    this.selRotation   = 0;
    this.hoveredCell   = null;   // [q, r] | null

    this.hexSize    = 40;
    this.boardOX    = 0;
    this.boardOY    = 0;

    this._sizeBoard();
    this._attachEvents();
    this._loadState();

    if (mode === "online") this._connectWS();
  }

  // ── Geometry ─────────────────────────────────────────────────────────

  _sizeBoard() {
    // Use window dimensions minus header (52px) + toolbar (52px) + padding
    const W = window.innerWidth - 220;   // 2 side panels ~100px each + padding
    const H = window.innerHeight - 120;  // header + toolbar + padding
    const side = Math.max(200, Math.min(W, H) - 16);

    this.canvas.width  = side;
    this.canvas.height = side;

    const cols = (2 * GRID_RADIUS + 1) * Math.sqrt(3);
    const rows = (2 * GRID_RADIUS + 1) * 1.5 + 0.5;
    this.hexSize = Math.floor(Math.min(side / cols, side / rows) * 0.88);

    this.boardOX = side / 2;
    this.boardOY = side / 2;
  }

  hexToPixel(q, r) {
    const x = this.hexSize * Math.sqrt(3) * (q + r / 2);
    const y = this.hexSize * 1.5 * r;
    return [this.boardOX + x, this.boardOY + y];
  }

  pixelToHex(px, py) {
    const x = px - this.boardOX;
    const y = py - this.boardOY;
    const q = (Math.sqrt(3) / 3 * x - 1/3 * y) / this.hexSize;
    const r = (2/3 * y) / this.hexSize;
    return this._hexRound(q, r);
  }

  _hexRound(fq, fr) {
    const fs = -fq - fr;
    let rq = Math.round(fq), rr = Math.round(fr), rs = Math.round(fs);
    const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds)        rr = -rq - rs;
    return [rq, rr];
  }

  inGrid(q, r) {
    return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= GRID_RADIUS;
  }

  // ── Drawing helpers ────────────────────────────────────────────────

  _hexPath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i - Math.PI / 6; // pointy-top: first vertex at top
      const x = cx + size * Math.cos(a);
      const y = cy + size * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  _drawArrow(ctx, cx, cy, angle, len) {
    const ex = cx + Math.cos(angle) * len;
    const ey = cy + Math.sin(angle) * len;
    const hl = len * 0.28;
    const ha = Math.PI / 5.5;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(angle - ha), ey - hl * Math.sin(angle - ha));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(angle + ha), ey - hl * Math.sin(angle + ha));
    ctx.stroke();
  }

  _drawPieceOnCanvas(ctx, cx, cy, size, player, type, rotation, selected = false) {
    const baseColor = player === "1" ? COLORS.p1 : COLORS.p2;
    const darkColor = player === "1" ? COLORS.p1dark : COLORS.p2dark;

    // Hex fill with gradient
    const grad = ctx.createRadialGradient(cx - size*0.2, cy - size*0.2, size*0.1, cx, cy, size);
    grad.addColorStop(0, baseColor);
    grad.addColorStop(1, darkColor);

    this._hexPath(ctx, cx, cy, size - 1.5);
    ctx.fillStyle = grad;
    ctx.fill();

    // Border
    ctx.strokeStyle = selected ? COLORS.lastMove : "rgba(255,255,255,0.25)";
    ctx.lineWidth   = selected ? 2.5 : 1;
    ctx.stroke();

    // Arrows
    const dirs = pieceDirections(type, rotation);
    if (dirs.length > 0) {
      ctx.strokeStyle = COLORS.arrow;
      ctx.lineWidth   = selected ? 2.2 : 1.8;
      for (const d of dirs) {
        this._drawArrow(ctx, cx, cy, DIR_ANGLES[d], size * 0.56);
      }
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.dot;
    ctx.fill();
  }

  // ── Board draw ─────────────────────────────────────────────────────

  _drawBoard() {
    const ctx = this.ctx;
    const s   = this.state;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Starfield-ish background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!s) return;

    const captures   = new Set(s.last_captures || []);
    const lastMove   = s.last_move;
    const lastMoveKey = lastMove ? `${lastMove.q},${lastMove.r}` : null;

    for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q++) {
      for (let r = -GRID_RADIUS; r <= GRID_RADIUS; r++) {
        if (!this.inGrid(q, r)) continue;

        const [cx, cy] = this.hexToPixel(q, r);
        const key      = `${q},${r}`;
        const cell     = s.board[key];
        const isHover  = this.hoveredCell &&
                         this.hoveredCell[0] === q &&
                         this.hoveredCell[1] === r;
        const canPlace = isHover && !cell && this.selIndex >= 0 && this._myTurn();

        // ── Fill ──
        if (cell) {
          const base  = cell.player === "1" ? COLORS.p1 : COLORS.p2;
          const dark  = cell.player === "1" ? COLORS.p1dark : COLORS.p2dark;
          const grad  = ctx.createRadialGradient(cx-this.hexSize*0.2, cy-this.hexSize*0.2,
                                                  this.hexSize*0.1, cx, cy, this.hexSize);
          grad.addColorStop(0, base);
          grad.addColorStop(1, dark);

          this._hexPath(ctx, cx, cy, this.hexSize - 1.5);
          ctx.fillStyle = grad;
          ctx.fill();
        } else if (canPlace) {
          this._hexPath(ctx, cx, cy, this.hexSize - 1.5);
          ctx.fillStyle = COLORS.hover;
          ctx.fill();
        } else {
          this._hexPath(ctx, cx, cy, this.hexSize - 1.5);
          ctx.fillStyle = COLORS.empty;
          ctx.fill();
        }

        // ── Border ──
        this._hexPath(ctx, cx, cy, this.hexSize - 1.5);
        if (canPlace) {
          ctx.strokeStyle = COLORS.hoverBdr;
          ctx.lineWidth   = 2;
        } else if (captures.has(key)) {
          ctx.strokeStyle = COLORS.capture;
          ctx.lineWidth   = 2.5;
        } else if (key === lastMoveKey) {
          ctx.strokeStyle = COLORS.lastMove;
          ctx.lineWidth   = 2;
        } else {
          ctx.strokeStyle = COLORS.emptyBdr;
          ctx.lineWidth   = 1;
        }
        ctx.stroke();

        // ── Arrows on placed piece ──
        if (cell) {
          const dirs = pieceDirections(cell.type, cell.rotation);
          if (dirs.length > 0) {
            ctx.strokeStyle = COLORS.arrow;
            ctx.lineWidth   = 1.8;
            for (const d of dirs) {
              this._drawArrow(ctx, cx, cy, DIR_ANGLES[d], this.hexSize * 0.56);
            }
          }
          ctx.beginPath();
          ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = COLORS.dot;
          ctx.fill();
        }

        // ── Ghost preview on hover ──
        if (canPlace) {
          const cp = this._currentPlayerPieces();
          if (cp && this.selIndex < cp.length) {
            const sp   = cp[this.selIndex];
            const dirs = pieceDirections(sp.type, this.selRotation);
            if (dirs.length > 0) {
              ctx.strokeStyle = "rgba(255,255,255,0.45)";
              ctx.lineWidth   = 1.5;
              for (const d of dirs) {
                this._drawArrow(ctx, cx, cy, DIR_ANGLES[d], this.hexSize * 0.56);
              }
            }
          }
        }
      }
    }
  }

  // ── Side panels ────────────────────────────────────────────────────

  _drawPanels() {
    if (!this.state) return;
    const s = this.state;

    // Turn indicator
    const ti = document.getElementById("turn-indicator");
    if (s.status === "finished") {
      ti.textContent = s.winner === "draw"
        ? "Ничья!"
        : `Победил Игрок ${s.winner}! 🏆`;
    } else {
      ti.textContent = `Ход Игрока ${s.current_player}`;
      ti.style.color = s.current_player === "1" ? "var(--p1-light)" : "var(--p2-light)";
    }

    // Scores
    document.getElementById("score1").textContent = s.scores["1"];
    document.getElementById("score2").textContent = s.scores["2"];

    this._renderPieceList("1");
    this._renderPieceList("2");

    // Toolbar
    const info     = document.getElementById("selected-info");
    const btnRot   = document.getElementById("btn-rotate");
    const btnDesel = document.getElementById("btn-deselect");

    if (this.selIndex >= 0 && this._myTurn()) {
      const cp = this._currentPlayerPieces();
      if (cp && this.selIndex < cp.length) {
        const p = cp[this.selIndex];
        const typeName = ["без меток", "2 метки", "3 метки"][p.type === 0 ? 0 : p.type === 2 ? 1 : 2];
        info.textContent = `Выбрана: ${typeName} | Поворот: ${this.selRotation * 60}°`;
        btnRot.disabled = false;
        btnDesel.style.display = "inline-flex";
      }
    } else {
      info.textContent = this._myTurn() ? "Выберите фишку из панели" : "";
      btnRot.disabled = true;
      btnDesel.style.display = "none";
    }
  }

  _renderPieceList(playerNum) {
    const container  = document.getElementById(`player${playerNum}-pieces`);
    const s          = this.state;
    const pieces     = s.players[playerNum].pieces;
    const isCurrent  = s.current_player === playerNum && s.status === "playing";
    const canInteract = (this.mode === "local" && isCurrent) ||
                        (this.mode === "online" && this.playerId === playerNum && isCurrent);

    // Rebuild canvas list whenever piece count changes
    if (container.childElementCount !== pieces.length) {
      container.innerHTML = "";
      for (let i = 0; i < pieces.length; i++) {
        const cvs = document.createElement("canvas");
        cvs.width  = 58;
        cvs.height = 58;
        cvs.className = "piece-item";
        // Use dynamic lookup to avoid stale-closure issue across turns
        const idx = i;
        cvs.addEventListener("click", () => {
          if (!this.state) return;
          const ss = this.state;
          const cur = ss.current_player === playerNum && ss.status === "playing";
          const allowed = (this.mode === "local" && cur) ||
                          (this.mode === "online" && this.playerId === playerNum && cur);
          if (!allowed) return;
          if (this.selIndex === idx) {
            this.selRotation = (this.selRotation + 1) % 6;
          } else {
            this.selIndex    = idx;
            this.selRotation = ss.players[playerNum].pieces[idx]?.rotation ?? 0;
          }
          this._render();
        });
        container.appendChild(cvs);
      }
    }

    pieces.forEach((piece, idx) => {
      const cvs = container.children[idx];
      if (!cvs) return;

      cvs.classList.toggle("interactive", canInteract);

      const isSel = isCurrent && this.selIndex === idx;
      cvs.classList.toggle("selected", isSel);

      const pctx     = cvs.getContext("2d");
      const rotation = isSel ? this.selRotation : piece.rotation;

      pctx.clearRect(0, 0, 58, 58);
      if (!isCurrent) pctx.globalAlpha = 0.45;
      this._drawPieceOnCanvas(pctx, 29, 29, 22, playerNum, piece.type, rotation, isSel);
      pctx.globalAlpha = 1;
    });
  }

  // ── Input ──────────────────────────────────────────────────────────

  _attachEvents() {
    const canvas = this.canvas;

    canvas.addEventListener("mousemove", (e) => {
      const r    = canvas.getBoundingClientRect();
      const [q, rv] = this.pixelToHex(e.clientX - r.left, e.clientY - r.top);
      this.hoveredCell = this.inGrid(q, rv) ? [q, rv] : null;
      this._drawBoard();
    });

    canvas.addEventListener("mouseleave", () => {
      this.hoveredCell = null;
      this._drawBoard();
    });

    canvas.addEventListener("click", (e) => {
      if (!this._myTurn() || this.selIndex < 0) return;
      const rect     = canvas.getBoundingClientRect();
      const [q, r]   = this.pixelToHex(e.clientX - rect.left, e.clientY - rect.top);
      if (!this.inGrid(q, r)) return;
      if (this.state.board[`${q},${r}`]) return;
      this._sendMove(q, r);
    });

    document.addEventListener("keydown", (e) => {
      if ((e.key === "r" || e.key === "R") && this.selIndex >= 0) {
        this.selRotation = (this.selRotation + 1) % 6;
        this._render();
      }
    });

    document.getElementById("btn-rotate").addEventListener("click", () => {
      if (this.selIndex >= 0) {
        this.selRotation = (this.selRotation + 1) % 6;
        this._render();
      }
    });

    document.getElementById("btn-deselect").addEventListener("click", () => {
      this.selIndex  = -1;
      this.selRotation = 0;
      this._render();
    });

    window.addEventListener("resize", () => {
      this._sizeBoard();
      this._render();
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _myTurn() {
    if (!this.state || this.state.status !== "playing") return false;
    if (this.mode === "local") return true;
    return this.state.current_player === this.playerId;
  }

  _currentPlayerPieces() {
    if (!this.state) return null;
    return this.state.players[this.state.current_player]?.pieces;
  }

  // ── Network ────────────────────────────────────────────────────────

  async _loadState() {
    try {
      const resp = await fetch(`/api/games/${this.gameId}`);
      this.state = await resp.json();
      this._render();
    } catch (err) {
      console.error("Failed to load game state", err);
    }
  }

  async _sendMove(q, r) {
    const cp = this.state.current_player;
    const body = {
      player:      cp,
      q,
      r,
      piece_index: this.selIndex,
      rotation:    this.selRotation,
    };

    if (this.mode === "online" && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "move", move: body }));
    } else {
      try {
        const resp = await fetch(`/api/games/${this.gameId}/move`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.error) {
          console.warn("Move rejected:", data.error);
          return;
        }
        this.state    = data.game;
        this.selIndex = -1;
        this.selRotation = 0;
        this._render();
        if (this.state.status === "finished") this._showGameOver();
      } catch (err) {
        console.error("Move error", err);
      }
    }
  }

  _connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url   = `${proto}//${location.host}/ws/${this.gameId}`;
    this.ws     = new WebSocket(url);

    this.ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "state_update") {
        const wasPlaying = this.state?.status === "playing";
        this.state = data.game;
        // Reset selection after opponent's move
        if (this.state.current_player === this.playerId) {
          this.selIndex = -1;
          this.selRotation = 0;
        }
        this._render();
        if (wasPlaying && this.state.status === "finished") this._showGameOver();
      }
    };

    this.ws.onclose = () => setTimeout(() => this._connectWS(), 3000);
  }

  // ── Game-over ──────────────────────────────────────────────────────

  _showGameOver() {
    const overlay = document.getElementById("game-over-overlay");
    const title   = document.getElementById("game-over-title");
    const desc    = document.getElementById("game-over-desc");
    const icon    = document.getElementById("game-over-icon");
    const s       = this.state;

    if (s.winner === "draw") {
      icon.textContent  = "🤝";
      title.textContent = "Ничья!";
      desc.textContent  = `Счёт: ${s.scores["1"]} : ${s.scores["2"]}`;
    } else {
      icon.textContent  = "🏆";
      title.textContent = `Победил Игрок ${s.winner}!`;
      desc.textContent  = `Счёт: ${s.scores["1"]} : ${s.scores["2"]}`;
    }

    overlay.style.display = "flex";
  }

  // ── Render entry-point ─────────────────────────────────────────────

  _render() {
    this._drawBoard();
    this._drawPanels();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const el       = document.getElementById("game-data");
  const gameId   = el.dataset.gameId;
  const playerId = el.dataset.playerId;
  const mode     = el.dataset.mode;

  window.hexGame = new HexGame(gameId, playerId, mode);
});
