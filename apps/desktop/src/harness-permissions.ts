// Permission requests can arrive from any streaming workflow, including several
// concurrent directives. Each button answers exactly the turn that created it.
export interface HarnessPermission {
  id: string;
  harness: string;
  label: string;
  document?: string;
  title: string;
  locations: string[];
}

export function showHarnessPermission(request: HarnessPermission, answer: (allow: boolean) => Promise<unknown>): () => void {
  const panel = document.querySelector<HTMLElement>("#harnessPermissions")!;
  const card = document.createElement("section");
  const heading = document.createElement("strong");
  heading.textContent = request.label + " requests permission";
  const detail = document.createElement("div");
  detail.textContent = [request.document, request.title, ...request.locations].filter(Boolean).join("\n");
  const actions = document.createElement("div");
  const buttons = ([["Reject", false], ["Allow once", true]] as const).map(([label, allow]) => {
    const button = document.createElement("button");
    button.className = "action";
    button.textContent = label;
    button.onclick = () => {
      for (const other of buttons) other.disabled = true;
      void answer(allow).finally(() => card.remove()).catch(() => {});
    };
    return button;
  });
  actions.append(...buttons);
  card.append(heading, detail, actions);
  panel.append(card);
  return () => card.remove();
}
