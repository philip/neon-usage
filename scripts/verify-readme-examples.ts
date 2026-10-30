import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function verifyReadmeExamples(
  checkout = fileURLToPath(new URL("..", import.meta.url)),
): void {
  const documents = [
    { file: "README.md", names: ["history", "contracts"] },
    { file: "docs/sdk.md", names: ["current", "coordinator"] },
  ].map(({ file, names }) => ({
    file,
    names,
    text: readFileSync(join(checkout, file), "utf8").replace(/\r\n/g, "\n"),
  }));
  const fixture = readFileSync(
    join(checkout, "package-fixtures/consumer/src/documentation.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const fixtureMarkers = [...fixture.matchAll(/^\/\/ README example: ([a-z]+)\n/gm)];
  const names = ["history", "current", "coordinator", "contracts"];
  if (JSON.stringify(fixtureMarkers.map((marker) => marker[1])) !== JSON.stringify(names))
    throw new Error(
      "Fixture example markers must be exactly history, current, coordinator, contracts",
    );
  const documented = new Map<string, { text: string; start: number; end: number | undefined }>();
  for (const document of documents) {
    const markers = [...document.text.matchAll(/^<!-- README example: ([a-z]+) -->$/gm)];
    if (JSON.stringify(markers.map((marker) => marker[1])) !== JSON.stringify(document.names))
      throw new Error(
        `${document.file} example markers must be exactly ${document.names.join(", ")}`,
      );
    for (const [index, marker] of markers.entries()) {
      const name = marker[1];
      if (name && marker.index !== undefined)
        documented.set(name, {
          text: document.text,
          start: marker.index + marker[0].length,
          end: markers[index + 1]?.index,
        });
    }
  }
  for (const [index, name] of names.entries()) {
    const documentation = documented.get(name);
    const fixtureMarker = fixtureMarkers[index];
    if (!documentation || !fixtureMarker) throw new Error(`Missing documentation example ${name}`);
    const snippet = documentation.text
      .slice(documentation.start, documentation.end)
      .match(/^\n\n```ts\n([\s\S]*?)\n```(?:\n|$)/)?.[1];
    const compiled = fixture
      .slice(
        fixtureMarker.index + fixtureMarker[0].length,
        fixtureMarkers[index + 1]?.index ?? fixture.length,
      )
      .replace(/\n+$/, "");
    if (snippet === undefined || snippet !== compiled)
      throw new Error(`Documentation example ${name} differs from the compiled package fixture`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyReadmeExamples();
}
