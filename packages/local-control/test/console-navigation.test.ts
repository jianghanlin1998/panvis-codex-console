import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
function fixture() {
  const memory = new Map<string, string>(); const directory = { innerHTML: "" };
  const elements = { querySelectorAll: () => [], classList: { toggle() {} } };
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").split("root.addEventListener('submit'")[0]!;
  const ui = runInNewContext(source + "\n({state,nav,progressGraph,mountGraphLayout})", {
    document: { getElementById: (id: string) => id === "project-nav" ? directory : elements },
    location: { hash: "#/project/prj_one" }, localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) },
  });
  return { ui, memory, directory };
}
describe("workspace navigation contracts", () => {
  it("keeps task progression order, puts ended projects below active ones, and only collapses completed tasks", () => {
    const f = fixture();
    f.ui.state.projects = [{ id: "prj_end", name: "Ended project", settings: { projectClosed: true }, tasks: [] },
      { id: "prj_one", name: "Current project", tasks: [
        { id: "bt_first", title: "First completed task", status: "DONE", subtasks: [{ id: "st_first", title: "First child", status: "DONE", materialized: true }] },
        { id: "bt_next", title: "Next active task", status: "IN_PROGRESS", subtasks: [] },
      ] }];
    f.ui.state.route = ["project", "prj_one"]; f.ui.nav();
    expect(f.directory.innerHTML.indexOf("Current project")).toBeLessThan(f.directory.innerHTML.indexOf("Ended project"));
    expect(f.directory.innerHTML.indexOf("First completed task")).toBeLessThan(f.directory.innerHTML.indexOf("Next active task"));
    expect(f.directory.innerHTML).not.toContain("First child"); expect(f.directory.innerHTML).toContain('aria-label="展开 First completed task"');
  });
  it("respects a manually collapsed project across a reload and expands it on a different deep link", () => {
    const f = fixture(); f.ui.state.projects = [{ id: "prj_one", name: "Current", tasks: [{ id: "bt_one", title: "Work", subtasks: [{ id: "st_one", title: "Child", materialized: true }] }] }];
    f.memory.set("ctc-tree", JSON.stringify({ "p:prj_one": { open: false, closed: false } }));
    f.memory.set("ctc-tree-route", "project:prj_one");
    f.ui.state.route = []; f.ui.nav(); f.ui.state.route = ["project", "prj_one"]; f.ui.nav();
    expect(f.directory.innerHTML).not.toContain("Child"); expect(f.directory.innerHTML).toContain('aria-label="展开 Current"');
    f.ui.state.route = ["subtask", "st_one"]; f.ui.nav();
    expect(f.directory.innerHTML).toContain("Child"); expect(f.directory.innerHTML).toContain('aria-label="折叠 Current"');
  });
  it("renders a fork and join with explicit dependency labels and CSP-compatible layout data", () => {
    const f = fixture();
    const nodes = ["a", "b", "c", "d"].map(id => ({ id, title: `Task ${id}`, status: "TODO", materialized: false }));
    const dependencies = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]].map(([from, to]) => ({ upstreamSubtaskId: from, downstreamSubtaskId: to, dependencyType: "BLOCKING" }));
    const html = f.ui.progressGraph([{ id: "bt_one", title: "Delivery", subtasks: nodes, dependencies }]);
    expect(html.match(/marker-end=/g)).toHaveLength(4); expect(html.match(/同列可并行/g)).toHaveLength(2);
    expect(html).toContain("依赖：2、3"); expect(html).toContain('data-width="840" data-height="392"');
    expect(html).not.toContain('style="'); expect(html).toContain("当前执行器一次推进一项");
  });
});
