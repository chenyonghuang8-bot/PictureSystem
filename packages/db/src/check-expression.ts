// This is a deliberately restricted CHECK grammar, not SQL equivalence solving.
// Parentheses disappear only after parsing has preserved their operator tree.
// Unknown syntax is compared literally: no regex-based semantic fallback.
type Token = { kind: "id" | "string" | "number" | "symbol"; text: string };
type Node = { text: string; atom?: "id" | "integer" };

export function canonicalCheck(value: string): string {
  try {
    if (value.length > 65_536) return value;
    const tokens = tokenize(value);
    let position = 0;
    let depth = 0;
    const peek = () => tokens[position]?.text;
    const take = (text: string) => {
      if (peek() !== text) return false;
      position++;
      return true;
    };
    const requireToken = (text: string) => {
      if (!take(text)) throw new Error("UNSUPPORTED_CHECK");
    };
    const binary = (a: Node, op: string, b: Node): Node => ({
      text: `(${a.text}${op}${b.text})`,
    });
    function primary(): Node {
      if (++depth > 128) throw new Error("UNSUPPORTED_CHECK");
      try {
        if (take("(")) {
          const result = or();
          requireToken(")");
          return result;
        }
        // MySQL emits negative integer bounds as -(840). Only an integer
        // atom (optionally wrapped) is accepted, never a general negation.
        if (take("-")) {
          const literal = primary();
          if (literal.atom !== "integer" || literal.text.startsWith("-"))
            throw new Error("UNSUPPORTED_CHECK");
          return { text: `-${literal.text}`, atom: "integer" };
        }
        const token = tokens[position++];
        if (!token) throw new Error("UNSUPPORTED_CHECK");
        if (token.kind === "number") {
          return {
            text: token.text,
            atom: "integer",
          };
        }
        if (token.kind === "string") return { text: token.text };
        if (token.kind !== "id") throw new Error("UNSUPPORTED_CHECK");
        let name = token.text;
        if (take(".")) {
          const column = tokens[position++];
          if (column?.kind !== "id") throw new Error("UNSUPPORTED_CHECK");
          name = column.text;
        }
        if (!take("(")) return { text: name, atom: "id" };
        // Aliases accept only the observed identifier / integer arguments.
        const arg = primary();
        if (arg.atom !== "id") throw new Error("UNSUPPORTED_CHECK");
        if (name === "mod") {
          requireToken(",");
          const divisor = primary();
          if (divisor.atom !== "integer") throw new Error("UNSUPPORTED_CHECK");
          requireToken(")");
          return binary(arg, "%", divisor);
        }
        if (!["abs", "char_length", "length", "octet_length"].includes(name))
          throw new Error("UNSUPPORTED_CHECK");
        requireToken(")");
        return {
          text: `${name === "octet_length" ? "length" : name}(${arg.text})`,
        };
      } finally {
        depth--;
      }
    }
    function scalar(): Node {
      const left = primary();
      if (!take("%")) return left;
      const right = primary();
      if (left.atom !== "id" || right.atom !== "integer")
        throw new Error("UNSUPPORTED_CHECK");
      return binary(left, "%", right);
    }
    function predicate(): Node {
      const left = scalar();
      if (take("is")) {
        const negative = take("not");
        requireToken("null");
        return { text: `(${left.text} is ${negative ? "not " : ""}null)` };
      }
      if (take("between")) {
        const low = scalar();
        requireToken("and");
        const high = scalar();
        return { text: `(${left.text} between ${low.text} and ${high.text})` };
      }
      const negative = take("not");
      if (take("in")) {
        requireToken("(");
        const values = [scalar().text];
        while (take(",")) values.push(scalar().text);
        requireToken(")");
        return {
          text: `(${left.text} ${negative ? "not " : ""}in (${values.join(",")}))`,
        };
      }
      if (negative) throw new Error("UNSUPPORTED_CHECK");
      const op = peek();
      if (op && ["=", "<>", "<", ">", "<=", ">="].includes(op)) {
        position++;
        return binary(left, op, scalar());
      }
      return left;
    }
    function not(): Node {
      // Only one NOT at a level is needed; repeated NOT remains literal.
      if (take("not")) return { text: `(not ${predicate().text})` };
      return predicate();
    }
    function and(): Node {
      let result = not();
      while (take("and")) result = binary(result, " and ", not());
      return result;
    }
    function or(): Node {
      let result = and();
      while (take("or")) result = binary(result, " or ", and());
      return result;
    }
    const result = or().text;
    if (position !== tokens.length) return value;
    // MySQL rewrites this one existing invitation CHECK. Match the WHOLE tree.
    if (result === "(not ((used_at is not null) and (revoked_at is not null)))")
      return "((used_at is null) or (revoked_at is null))";
    return result;
  } catch {
    return value;
  }
}

function tokenize(value: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  while (offset < value.length) {
    if (result.length >= 8192) throw new Error("UNSUPPORTED_CHECK");
    const rest = value.slice(offset);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    // Only this known charset, and only simple literals with no escape payload.
    const introduced = /^_utf8mb4(?:'([^'\\]*)'|\\'([^'\\]*)\\')/i.exec(rest);
    if (introduced) {
      result.push({
        kind: "string",
        text: `'${introduced[1] ?? introduced[2]}'`,
      });
      offset += introduced[0].length;
      continue;
    }
    const literal = /^'[^'\\]*'/.exec(rest);
    if (literal) {
      result.push({ kind: "string", text: literal[0] });
      offset += literal[0].length;
      continue;
    }
    const quoted = /^`([a-z_][a-z0-9_]*)`/i.exec(rest);
    const identifier = /^[a-z_][a-z0-9_]*/i.exec(rest);
    if (quoted || identifier) {
      const match = quoted ?? identifier!;
      result.push({
        kind: "id",
        text: (quoted ? quoted[1]! : match[0]).toLowerCase(),
      });
      offset += match[0].length;
      continue;
    }
    const number = /^\d+/.exec(rest);
    if (number) {
      result.push({ kind: "number", text: number[0] });
      offset += number[0].length;
      continue;
    }
    const symbol = /^(?:<>|<=|>=|[()=<>%,.-])/.exec(rest);
    if (!symbol) throw new Error("UNSUPPORTED_CHECK");
    result.push({ kind: "symbol", text: symbol[0] });
    offset += symbol[0].length;
  }
  return result;
}
