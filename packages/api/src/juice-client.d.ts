// juice's browser / Workers build (no fs / web-resource-inliner): the same `juice(html)` function.
declare module "juice/client" {
  import juice from "juice";
  export default juice;
}
