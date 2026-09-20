/** Wall-clock presentation tween; never advances restaurant time. */
export class BubbleMotion {
  value = 0;
  target = false;
  private from = 0;
  private startedAt = 0;
  private duration = 1;

  setVisible(visible: boolean, now: number) {
    if (visible === this.target) return;
    this.sample(now);
    this.from = this.value;
    this.target = visible;
    this.startedAt = now;
    this.duration = visible ? 260 : 180;
  }

  sample(now: number) {
    const t = Math.max(0, Math.min(1, (now - this.startedAt) / this.duration));
    if (t === 0) return this.value = this.from;
    if (t === 1) return this.value = this.target ? 1 : 0;
    // A small overshoot feels like a balloon opening; exit folds into its tip.
    const eased = this.target ? 1 + 1.65 * (t - 1) ** 3 + 0.65 * (t - 1) ** 2 : t * t;
    this.value = Math.max(0, this.from + ((this.target ? 1 : 0) - this.from) * eased);
    return this.value;
  }
}
