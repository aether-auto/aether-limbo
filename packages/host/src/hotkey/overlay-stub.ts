import type { IOverlayController } from "./types.js";

export class NullOverlayController implements IOverlayController {
  private open_ = false;
  opens = 0;
  closes = 0;
  inputs: string[] = [];

  isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.opens++;
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.closes++;
  }

  handleInput(chunk: string): void {
    this.inputs.push(chunk);
  }

  resizes: Array<{ cols: number; rows: number }> = [];
  handleResize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
}
