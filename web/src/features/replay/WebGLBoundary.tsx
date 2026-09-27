import { Component, type ReactNode } from "react"

type Props = { fallback: ReactNode; children: ReactNode }

/** Shows `fallback` (the flat house art) if the 3D view throws, e.g. a lost or refused WebGL context. */
export class WebGLBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
