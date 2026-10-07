/// <reference types="node" />
// Node-only synthetic filesystem adapter for controller regression tests.
import * as fs from "node:fs";
import * as path from "node:path";
export class TestDirectory {
  uri: string;
  constructor(...parts: (string | TestDirectory)[]) {
    this.uri = path.join(
      ...parts.map((p) => (typeof p === "string" ? p : p.uri)),
    );
  }
  get exists() {
    return fs.existsSync(this.uri);
  }
  create() {
    fs.mkdirSync(this.uri, { recursive: true });
  }
  delete() {
    fs.rmSync(this.uri, { recursive: true });
  }
  list() {
    return fs.readdirSync(this.uri).map((n) => new TestFile(this, n));
  }
}
export class TestFile {
  uri: string;
  constructor(...parts: (string | TestDirectory)[]) {
    this.uri = path.join(
      ...parts.map((p) => (typeof p === "string" ? p : p.uri)),
    );
  }
  get name() {
    return path.basename(this.uri);
  }
  get exists() {
    return fs.existsSync(this.uri);
  }
  get size() {
    return fs.statSync(this.uri).size;
  }
  create() {
    fs.writeFileSync(this.uri, "", { flag: "wx" });
  }
  write(s: string) {
    fs.writeFileSync(this.uri, s);
  }
  delete() {
    fs.unlinkSync(this.uri);
  }
  move(dest: TestFile) {
    fs.renameSync(this.uri, dest.uri);
    this.uri = dest.uri;
  }
  open() {
    const fd = fs.openSync(this.uri, "r+");
    const handle = {
      offset: 0,
      readBytes(n: number) {
        const b = Buffer.alloc(n);
        const read = fs.readSync(fd, b, 0, n, this.offset);
        this.offset += read;
        return new Uint8Array(b.subarray(0, read));
      },
      writeBytes(b: Uint8Array) {
        fs.writeSync(fd, b, 0, b.length, this.offset);
        this.offset += b.length;
      },
      close() {
        fs.closeSync(fd);
      },
    };
    return handle;
  }
}
