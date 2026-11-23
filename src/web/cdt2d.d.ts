declare module 'cdt2d' {
  export default function cdt2d(
    points: [number, number][],
    edges?: [number, number][],
    options?: { delaunay?: boolean; interior?: boolean; exterior?: boolean },
  ): [number, number, number][]
}
