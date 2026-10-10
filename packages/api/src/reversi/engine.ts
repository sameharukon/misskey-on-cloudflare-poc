/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Minimal port of upstream `packages/misskey-reversi` (game.ts, serializer.ts and the default
 * `eighteight` map from maps.ts). `crc-32`'s `CRC32.str` is reimplemented below (signed 32-bit
 * CRC-32 of the UTF-8 bytes), so `calcCrc32()` matches the client's value.
 */

/** true ... black, false ... white */
export type Color = boolean;
const BLACK = true;
const WHITE = false;

export type MapCell = "null" | "empty";

export type Options = {
  isLlotheo: boolean;
  canPutEverywhere: boolean;
  loopedBoard: boolean;
};

type Undo = { color: Color; pos: number; effects: number[]; turn: Color | null };

/** maps.ts `eighteight` (the default map of a new game). */
export const EIGHTEIGHT: string[] = ["--------", "--------", "--------", "---wb---", "---bw---", "--------", "--------", "--------"];

let CRC_TABLE: Int32Array | null = null;
function crcTable(): Int32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (CRC_TABLE = t);
}

/** `CRC32.str` from the `crc-32` package (signed int32). */
export function crc32Str(s: string): number {
  const t = crcTable();
  let c = -1;
  for (const b of new TextEncoder().encode(s)) c = (c >>> 8) ^ t[(c ^ b) & 0xff]!;
  return c ^ -1;
}

export class Game {
  public map: MapCell[];
  public mapWidth: number;
  public mapHeight: number;
  public board: (Color | null | undefined)[];
  public turn: Color | null = BLACK;
  public opts: Options;

  public prevPos = -1;
  public prevColor: Color | null = null;

  private logs: Undo[] = [];

  constructor(map: string[], opts: Options) {
    this.putStone = this.putStone.bind(this);
    this.opts = {
      isLlotheo: opts.isLlotheo ?? false,
      canPutEverywhere: opts.canPutEverywhere ?? false,
      loopedBoard: opts.loopedBoard ?? false,
    };

    this.mapWidth = map[0]!.length;
    this.mapHeight = map.length;
    const mapData = map.join("");
    this.board = mapData.split("").map((d) => (d === "-" ? null : d === "b" ? BLACK : d === "w" ? WHITE : undefined));
    this.map = mapData.split("").map((d) => (d === "-" || d === "b" || d === "w" ? "empty" : "null"));

    // a map may start with stones of one colour only, or already decided
    if (!this.canPutSomewhere(BLACK)) this.turn = this.canPutSomewhere(WHITE) ? WHITE : null;
  }

  public get blackCount() {
    return this.board.filter((x) => x === BLACK).length;
  }

  public get whiteCount() {
    return this.board.filter((x) => x === WHITE).length;
  }

  public posToXy(pos: number): number[] {
    const x = pos % this.mapWidth;
    const y = Math.floor(pos / this.mapWidth);
    return [x, y];
  }

  public xyToPos(x: number, y: number): number {
    return x + y * this.mapWidth;
  }

  public putStone(pos: number) {
    const color = this.turn;
    if (color == null) return;
    this.prevPos = pos;
    this.prevColor = color;
    this.board[pos] = color;
    const effects = this.effects(color, pos);
    for (const p of effects) this.board[p] = color;
    const turn = this.turn;
    this.logs.push({ color, pos, effects, turn });
    this.calcTurn();
  }

  private calcTurn() {
    this.turn = this.canPutSomewhere(!this.prevColor) ? !this.prevColor : this.canPutSomewhere(this.prevColor!) ? this.prevColor : null;
  }

  public undo() {
    const undo = this.logs.pop();
    if (undo == null) return;
    this.prevColor = undo.color;
    this.prevPos = undo.pos;
    this.board[undo.pos] = null;
    for (const pos of undo.effects) {
      const color = this.board[pos];
      this.board[pos] = !color;
    }
    this.turn = undo.turn;
  }

  public mapDataGet(pos: number): MapCell {
    const [x, y] = this.posToXy(pos) as [number, number];
    return x < 0 || y < 0 || x >= this.mapWidth || y >= this.mapHeight ? "null" : this.map[pos]!;
  }

  public getPuttablePlaces(color: Color): number[] {
    return Array.from(this.board.keys()).filter((i) => this.canPut(color, i));
  }

  public canPutSomewhere(color: Color): boolean {
    return this.getPuttablePlaces(color).length > 0;
  }

  public canPut(color: Color, pos: number): boolean {
    return this.board[pos] !== null
      ? false // occupied (or not a cell)
      : this.opts.canPutEverywhere
        ? this.mapDataGet(pos) === "empty"
        : this.effects(color, pos).length !== 0;
  }

  /** Stones flipped by putting `color` at `initPos`. */
  public effects(color: Color, initPos: number): number[] {
    const enemyColor = !color;
    const diffVectors: [number, number][] = [
      [0, -1],
      [+1, -1],
      [+1, 0],
      [+1, +1],
      [0, +1],
      [-1, +1],
      [-1, 0],
      [-1, -1],
    ];

    const effectsInLine = ([dx, dy]: [number, number]): number[] => {
      const found: number[] = [];
      let [x, y] = this.posToXy(initPos) as [number, number];
      while (true) {
        x += dx;
        y += dy;
        if (
          this.opts.loopedBoard &&
          this.xyToPos((x = ((x % this.mapWidth) + this.mapWidth) % this.mapWidth), (y = ((y % this.mapHeight) + this.mapHeight) % this.mapHeight)) === initPos
        ) {
          return found;
        } else if (x === -1 || y === -1 || x === this.mapWidth || y === this.mapHeight) return [];
        const pos = this.xyToPos(x, y);
        if (this.mapDataGet(pos) === "null") return [];
        const stone = this.board[pos];
        if (stone === null) return [];
        if (stone === enemyColor) found.push(pos);
        if (stone === color) return found;
      }
    };

    return ([] as number[]).concat(...diffVectors.map(effectsInLine));
  }

  public calcCrc32(): number {
    return crc32Str(JSON.stringify({ board: this.board, turn: this.turn }));
  }

  public get isEnded(): boolean {
    return this.turn === null;
  }

  public get winner(): Color | null {
    return this.isEnded
      ? this.blackCount === this.whiteCount
        ? null
        : this.opts.isLlotheo === this.blackCount > this.whiteCount
          ? WHITE
          : BLACK
      : (undefined as never);
  }
}

// ---------------------------------------------------------------- serializer.ts

export type Log = { time: number; player: boolean; operation: "put"; pos: number };
export type SerializedLog = number[];

export function serializeLogs(logs: Log[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]!;
    const timeDelta = i === 0 ? log.time : log.time - logs[i - 1]!.time;
    if (log.operation === "put") out.push([timeDelta, log.player ? 1 : 0, 0, log.pos]);
  }
  return out;
}

export function deserializeLogs(logs: SerializedLog[]): Log[] {
  const out: Log[] = [];
  let time = 0;
  for (const log of logs) {
    time += log[0]!;
    if (log[2] === 0) out.push({ time, player: log[1] === 1, operation: "put", pos: log[3]! });
  }
  return out;
}

export function restoreGame(env: { map: string[]; isLlotheo: boolean; canPutEverywhere: boolean; loopedBoard: boolean; logs: SerializedLog[] }): Game {
  const game = new Game(env.map, { isLlotheo: env.isLlotheo, canPutEverywhere: env.canPutEverywhere, loopedBoard: env.loopedBoard });
  for (const log of deserializeLogs(env.logs)) if (log.operation === "put") game.putStone(log.pos);
  return game;
}
