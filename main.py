"""
Гекснашки – FastAPI backend.
Hex grid: axial coordinates (q, r), radius 3 → 37 cells.
Directions (pointy-top): E=0, NE=1, NW=2, W=3, SW=4, SE=5
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.requests import Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="Гекснашки")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ---------------------------------------------------------------------------
# Hex geometry helpers
# ---------------------------------------------------------------------------

# Neighbour offsets in axial coordinates (pointy-top, flat sides E/W)
HEX_DIRS: List[tuple[int, int]] = [
    (1,  0),   # 0 – E
    (1, -1),   # 1 – NE
    (0, -1),   # 2 – NW
    (-1, 0),   # 3 – W
    (-1, 1),   # 4 – SW
    (0,  1),   # 5 – SE
]

GRID_RADIUS = 3  # 37 cells total


def in_grid(q: int, r: int, radius: int = GRID_RADIUS) -> bool:
    return max(abs(q), abs(r), abs(q + r)) <= radius


def all_cells(radius: int = GRID_RADIUS) -> List[tuple[int, int]]:
    return [
        (q, r)
        for q in range(-radius, radius + 1)
        for r in range(-radius, radius + 1)
        if in_grid(q, r, radius)
    ]


TOTAL_CELLS = len(all_cells())  # 37


def piece_directions(piece_type: int, rotation: int) -> List[int]:
    """Return the six-direction indices that a piece points to."""
    if piece_type == 0:
        return []
    base = [0, 3] if piece_type == 2 else [0, 2, 4]  # opposite or alternating
    return [(d + rotation) % 6 for d in base]


# ---------------------------------------------------------------------------
# Game creation / mutation
# ---------------------------------------------------------------------------

def _make_pieces() -> List[dict]:
    """Each player gets 9 pieces: 3×blank, 3×two-arrows, 3×three-arrows."""
    pieces = []
    for ptype in [0, 0, 0, 2, 2, 2, 3, 3, 3]:
        pieces.append({"type": ptype, "rotation": 0, "id": uuid.uuid4().hex[:6]})
    return pieces


def create_game(mode: str = "local") -> dict:
    gid = uuid.uuid4().hex[:8]
    return {
        "id": gid,
        "mode": mode,
        "board": {},            # key "q,r" → {player, type, rotation}
        "players": {
            "1": {"pieces": _make_pieces()},
            "2": {"pieces": _make_pieces()},
        },
        "current_player": "1",
        "status": "playing",    # both modes start immediately; player check enforces turns
        "winner": None,
        "scores": {"1": 0, "2": 0},
        "last_move": None,
        "last_captures": [],
    }


def apply_move(
    game: dict,
    player_id: str,
    q: int,
    r: int,
    piece_index: int,
    rotation: int,
) -> tuple[bool, str]:
    """Validate and apply a move.  Returns (ok, message)."""
    if game["status"] != "playing":
        return False, "Игра завершена"
    if game["current_player"] != player_id:
        return False, "Сейчас не ваш ход"

    player = game["players"][player_id]
    if not (0 <= piece_index < len(player["pieces"])):
        return False, "Неверный индекс фишки"

    board_key = f"{q},{r}"
    if board_key in game["board"]:
        return False, "Клетка занята"
    if not in_grid(q, r):
        return False, "Клетка вне поля"

    piece = player["pieces"][piece_index]
    ptype = piece["type"]
    dirs = piece_directions(ptype, rotation)

    # Place piece
    game["board"][board_key] = {"player": player_id, "type": ptype, "rotation": rotation}

    # --- Capture logic ---
    captures: set[str] = set()

    for d in dirs:
        dq, dr = HEX_DIRS[d]
        nq, nr = q + dq, r + dr
        nkey = f"{nq},{nr}"

        if nkey not in game["board"]:
            continue
        neighbor = game["board"][nkey]
        if neighbor["player"] == player_id:
            continue

        # Basic capture: our arrow points at opponent's cell
        captures.add(nkey)

        # Chain capture: labels "match" when opponent also points back at us
        n_dirs = piece_directions(neighbor["type"], neighbor["rotation"])
        opposite = (d + 3) % 6
        if opposite in n_dirs:
            # Capture everything the opponent's piece points at (one step only)
            for nd in n_dirs:
                ndq, ndr = HEX_DIRS[nd]
                nnq, nnr = nq + ndq, nr + ndr
                nnkey = f"{nnq},{nnr}"
                if nnkey == board_key:
                    continue
                if nnkey in game["board"] and game["board"][nnkey]["player"] != player_id:
                    captures.add(nnkey)

    # Apply captures (change ownership)
    for key in captures:
        game["board"][key]["player"] = player_id

    game["last_captures"] = list(captures)
    game["last_move"] = {"player": player_id, "q": q, "r": r, "type": ptype, "rotation": rotation}

    # Remove used piece
    player["pieces"].pop(piece_index)

    # Update scores
    scores: dict[str, int] = {"1": 0, "2": 0}
    for cell in game["board"].values():
        scores[cell["player"]] += 1
    game["scores"] = scores

    # Check end condition
    all_used = all(len(p["pieces"]) == 0 for p in game["players"].values())
    board_full = len(game["board"]) >= TOTAL_CELLS

    if all_used or board_full:
        if scores["1"] > scores["2"]:
            game["winner"] = "1"
        elif scores["2"] > scores["1"]:
            game["winner"] = "2"
        else:
            game["winner"] = "draw"
        game["status"] = "finished"
    else:
        game["current_player"] = "2" if player_id == "1" else "1"

    return True, "OK"


# ---------------------------------------------------------------------------
# In-memory storage
# ---------------------------------------------------------------------------

games: Dict[str, dict] = {}
ws_pool: Dict[str, List[WebSocket]] = {}


async def broadcast(game_id: str, payload: dict) -> None:
    dead: List[WebSocket] = []
    for ws in ws_pool.get(game_id, []):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_pool[game_id].remove(ws)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/create-game")
async def create_game_route(request: Request):
    body = await request.json()
    mode = body.get("mode", "local")
    game = create_game(mode)
    games[game["id"]] = game
    return {"game_id": game["id"]}


@app.get("/game/{game_id}", response_class=HTMLResponse)
async def game_page(request: Request, game_id: str, player: str = "1"):
    if game_id not in games:
        return RedirectResponse("/")
    return templates.TemplateResponse(
        "game.html",
        {
            "request": request,
            "game_id": game_id,
            "player_id": player,
            "mode": games[game_id]["mode"],
        },
    )


@app.get("/api/games/{game_id}")
async def get_game(game_id: str):
    if game_id not in games:
        return JSONResponse({"error": "Игра не найдена"}, status_code=404)
    return games[game_id]


@app.post("/api/games/{game_id}/move")
async def make_move(game_id: str, request: Request):
    if game_id not in games:
        return JSONResponse({"error": "Игра не найдена"}, status_code=404)

    body = await request.json()
    game = games[game_id]

    ok, msg = apply_move(
        game,
        str(body.get("player", "")),
        int(body.get("q", 0)),
        int(body.get("r", 0)),
        int(body.get("piece_index", 0)),
        int(body.get("rotation", 0)),
    )

    if not ok:
        return JSONResponse({"error": msg}, status_code=400)

    await broadcast(game_id, {"type": "state_update", "game": game})
    return {"success": True, "game": game}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws/{game_id}")
async def ws_endpoint(websocket: WebSocket, game_id: str):
    await websocket.accept()

    ws_pool.setdefault(game_id, []).append(websocket)

    try:
        if game_id in games:
            await websocket.send_json({"type": "state_update", "game": games[game_id]})

        while True:
            data = await websocket.receive_json()

            if data.get("type") == "move" and game_id in games:
                mv = data.get("move", {})
                game = games[game_id]
                ok, msg = apply_move(
                    game,
                    str(mv.get("player", "")),
                    int(mv.get("q", 0)),
                    int(mv.get("r", 0)),
                    int(mv.get("piece_index", 0)),
                    int(mv.get("rotation", 0)),
                )
                await broadcast(
                    game_id,
                    {"type": "state_update", "game": game, "ok": ok, "msg": msg},
                )
    except WebSocketDisconnect:
        pool = ws_pool.get(game_id, [])
        if websocket in pool:
            pool.remove(websocket)
