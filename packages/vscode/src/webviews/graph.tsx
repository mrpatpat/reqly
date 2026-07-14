import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import cytoscape from "cytoscape";

function Graph(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const data = window.__REQLY_DATA__;
    const graph = cytoscape({
      container: host.current,
      elements: [
        ...data.nodes.map((node: any) => ({ data: { id: node.id, label: `${node.id}\n${node.label}`, status: node.status, type: node.type } })),
        ...data.edges.map((edge: any, index: number) => ({ data: { id: `edge-${index}`, source: edge.source, target: edge.target, label: edge.type } })),
      ],
      style: [
        { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", color: "var(--vscode-editor-foreground)", "background-color": "var(--vscode-charts-blue)", "font-size": 11, width: 42, height: 42 } },
        { selector: "edge", style: { label: "data(label)", width: 1.5, "line-color": "var(--vscode-editorWidget-border)", "target-arrow-color": "var(--vscode-editorWidget-border)", "target-arrow-shape": "triangle", "curve-style": "bezier", "font-size": 9, color: "var(--vscode-descriptionForeground)" } },
      ],
      layout: { name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.4 },
    });
    graph.on("tap", "node", (event) => acquireVsCodeApi().postMessage({ type: "open", id: event.target.id() }));
    return () => graph.destroy();
  }, []);
  return <div ref={host} style={{ width: "100vw", height: "100vh" }} aria-label="Requirement graph" />;
}

createRoot(document.getElementById("root")!).render(<Graph />);
