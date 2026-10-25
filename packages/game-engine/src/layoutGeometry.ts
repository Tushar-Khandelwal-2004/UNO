export interface LayoutRect {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LayoutIssueReport {
  overlaps: string[];
  outside: string[];
  scroll: boolean;
}

export function checkLayout(rects: LayoutRect[], viewportWidth: number, viewportHeight: number, scrollHeight: number): LayoutIssueReport {
  const overlaps: string[] = [];
  for (let first = 0; first < rects.length; first += 1) {
    for (let second = first + 1; second < rects.length; second += 1) {
      const a = rects[first]!;
      const b = rects[second]!;
      if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) overlaps.push(`${a.name}:${b.name}`);
    }
  }
  const outside = rects.filter((rect) => rect.left < 0 || rect.top < 0 || rect.right > viewportWidth || rect.bottom > viewportHeight).map((rect) => rect.name);
  return { overlaps, outside, scroll: scrollHeight > viewportHeight };
}
