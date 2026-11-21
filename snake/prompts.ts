// CHE-1166's Snake prompts, copied as template source text from hybrid-development-eval src/snake.ts at the
// manifest's codeCommit. `prepare` re-reads that file with git show and refuses to start unless each matches.
// Placeholders (${name}) and \n escapes are rendered by `render`.

export const BOUNDARY = 'Follow TASK.md and AGENTS.md. Work offline, editing only src/snake.html through actual tools. Do not run or test the game, use a browser, start a server, install packages, inspect another workspace, or investigate networking. Che will play-test the result. Make a working file early, then refine it. Source reasoning is allowed; execution is not.';
export const PLANNER = 'You are the frontier orchestrator. Read the contract and empty starter read-only. Give one implementation assignment. Do not write code or a complete solution. Use implement or blocked. ${boundary}\\nPRODUCT CONTRACT\\n${task}';
export const IMPLEMENT = '${boundary}\\nPRODUCT CONTRACT\\n${task}\\nASSIGNMENT\\n${assignment}';
export const REVIEW = 'Review src/snake.html read-only against TASK.md. Do not execute or test it. Inspect source for likely correctness and contract compliance. This is a source review, not evidence the game works. Accept if satisfactory, otherwise revise with a scoped correction assignment or blocked. No replacement code. ${boundary}\\nHOST EVIDENCE\\nFile exists; frozen scope intact; gameplay has NOT been tested.\\nPRODUCT CONTRACT\\n${task}';
export const RETRY = 'Finish the unchanged task in the actual file. Prior call exit=${call.exitCode}, stop=${call.stopReason}, nonempty file=${present}. Keep useful existing work. Write the file early. Do not execute the game or investigate network access.';

export const TEMPLATES = { BOUNDARY, PLANNER, IMPLEMENT, REVIEW, RETRY } as const;

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([a-zA-Z.]+)\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`missing prompt variable ${k}`);
    return v;
  }).replace(/\\n/g, '\n');
}

/** Each template must appear verbatim as a template literal in CHE-1166's source. */
export function verifyAgainst(source: string): string[] {
  const missing: string[] = [];
  for (const [name, t] of Object.entries(TEMPLATES)) if (!source.includes('`' + t + '`')) missing.push(name);
  return missing;
}
