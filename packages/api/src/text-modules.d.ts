/** `.txt` files are Text modules (wrangler's default rule; scripts/test-resolve.mjs under Node). */
declare module "*.txt" {
  const text: string;
  export default text;
}
