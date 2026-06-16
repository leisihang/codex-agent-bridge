import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class JsonLineRpcProcessClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.name = options.name ?? this.command ?? "json-line-rpc-process";
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    if (this.child) {
      return;
    }
    if (!this.command) {
      throw new Error("JsonLineRpcProcessClient requires a command.");
    }

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`${this.name} exited with code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", { code, signal });
    });

    this.child.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
  }

  stop() {
    if (!this.child) {
      return;
    }
    this.child.stdin.end();
    this.child.kill();
  }

  request(method, params) {
    if (!this.child) {
      throw new Error(`${this.name} is not running`);
    }

    const id = this.nextId++;
    const message = { method, id, params };
    const payload = `${JSON.stringify(message)}\n`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method, params) {
    if (!this.child) {
      throw new Error(`${this.name} is not running`);
    }
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    if (!this.child) {
      throw new Error(`${this.name} is not running`);
    }
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("protocolError", { error, line });
      return;
    }

    if (
      Object.hasOwn(message, "id") &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("unmatchedResponse", message);
        return;
      }
      this.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("unknownMessage", message);
  }
}
