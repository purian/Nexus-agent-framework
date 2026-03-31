import type { Tool } from "../types/index.js";

export { bashTool } from "./bash.js";
export { readFileTool } from "./read-file.js";
export { writeFileTool } from "./write-file.js";
export { editFileTool } from "./edit-file.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { webFetchTool } from "./web-fetch.js";

import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";

/**
 * Returns the default set of built-in tools for the Nexus agent framework.
 */
export function createDefaultTools(): Tool[] {
  return [
    bashTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    webFetchTool,
  ];
}
