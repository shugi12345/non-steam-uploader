// Minimal text VDF (KeyValues) parser/writer, used for Steam's config.vdf on Linux.
// ponytail: ignores #include/#base and conditionals ([$WIN32]); config.vdf never uses them.

function parse(text) {
  let i = 0;

  const skip = () => {
    while (i < text.length) {
      if (/\s/.test(text[i])) {
        i += 1;
      } else if (text.startsWith("//", i)) {
        while (i < text.length && text[i] !== "\n") i += 1;
      } else {
        return;
      }
    }
  };

  const readToken = () => {
    skip();
    if (i >= text.length) return null;
    const ch = text[i];
    if (ch === "{" || ch === "}") {
      i += 1;
      return { brace: ch };
    }
    if (ch === '"') {
      i += 1;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          out += text[i];
          i += 1;
        }
      }
      i += 1;
      return { str: out };
    }
    const start = i;
    while (i < text.length && !/[\s{}"]/.test(text[i])) i += 1;
    return { str: text.slice(start, i) };
  };

  const readObject = (nested) => {
    const obj = {};
    for (;;) {
      const key = readToken();
      if (!key) {
        if (nested) throw new Error("Unexpected end of VDF.");
        return obj;
      }
      if (key.brace === "}") {
        if (!nested) throw new Error("Unexpected '}' in VDF.");
        return obj;
      }
      if (key.brace) throw new Error("Unexpected '{' in VDF.");
      const value = readToken();
      if (!value) throw new Error(`Missing value for "${key.str}".`);
      if (value.brace === "{") obj[key.str] = readObject(true);
      else if (value.brace) throw new Error("Unexpected '}' in VDF.");
      else obj[key.str] = value.str;
    }
  };

  return readObject(false);
}

function stringify(obj, depth = 0) {
  const pad = "\t".repeat(depth);
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") {
      out += `${pad}"${esc(key)}"\n${pad}{\n${stringify(value, depth + 1)}${pad}}\n`;
    } else {
      out += `${pad}"${esc(key)}"\t\t"${esc(value)}"\n`;
    }
  }
  return out;
}

// Case-insensitive child lookup that creates the child when missing (Steam mixes "Valve"/"valve").
function child(obj, name) {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  if (found) return obj[found];
  obj[name] = {};
  return obj[name];
}

module.exports = { parse, stringify, child };

if (require.main === module) {
  const assert = require("assert");
  const src = `"InstallConfigStore"
{
\t// comment
\t"Software" { "valve" { "Steam" { "path" "C:\\\\Games\\\\x \\"q\\"" "CompatToolMapping" { } } } }
}`;
  const parsed = parse(src);
  const steam = child(child(child(parsed, "InstallConfigStore"), "software"), "Valve").Steam;
  assert.strictEqual(steam.path, 'C:\\Games\\x "q"');
  child(steam, "CompatToolMapping")["123"] = { name: "proton_experimental", config: "", priority: "250" };
  const again = parse(stringify(parsed));
  assert.deepStrictEqual(again, parsed);
  assert.strictEqual(again.InstallConfigStore.Software.valve.Steam.CompatToolMapping["123"].priority, "250");
  console.log("textVdf ok");
}
