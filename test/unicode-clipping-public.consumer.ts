import { buildBlockKit } from "../dist/index.js";
import { registerUnicodeClippingTests } from "./unicode-clipping-contract.ts";

registerUnicodeClippingTests("public entry", buildBlockKit);
