import { readHistory, searchHistory } from "./history.ts";
import { setTimezone, updateIdentity } from "./identity.ts";
import { memoryTools } from "./memory.ts";
import { cancelSchedule, listSchedules, schedule } from "./schedules.ts";
import type { Tool } from "./types.ts";

// Every tool the assistant has. To add one, write a file next to this one
// exporting a ReadTool or a ChangeTool, and list it here. Order matters for
// prompt caching: keep it stable.
export const TOOLS: Tool[] = [...memoryTools, schedule, cancelSchedule, listSchedules, setTimezone, updateIdentity, searchHistory, readHistory];

export const toolByName = (name: string) => TOOLS.find((t) => t.definition.name === name);
