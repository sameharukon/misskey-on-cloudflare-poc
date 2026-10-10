// Tests and the endpoint scripts (Node): lets Node import `cloudflare:workers`, which exists only in workerd.
import { register } from "node:module";

register("./test-resolve.mjs", import.meta.url);
