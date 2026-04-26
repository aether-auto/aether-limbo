import type { IOverlayController } from "./types.js";

export class NullOverlayController implements IOverlayController {
  private open_ = false;
  opens = 0;
  closes = 0;

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
}
