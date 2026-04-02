import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ToolDefinition } from './copilot-client';

export function fileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function buildCodeTools(repoPath: string): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read the full content of a file in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repository root' },
        },
        required: ['path'],
      },
      handler: async ({ path: filePath }) => {
        const full = path.resolve(repoPath, filePath as string);
        if (!full.startsWith(path.resolve(repoPath))) throw new Error('Path traversal not allowed');
        if (!fs.existsSync(full)) return { error: `File not found: ${filePath}` };
        return { content: fs.readFileSync(full, 'utf-8') };
      },
    },
    {
      name: 'write_file',
      description: 'Write or overwrite a file in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repository root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
      handler: async ({ path: filePath, content }) => {
        const full = path.resolve(repoPath, filePath as string);
        if (!full.startsWith(path.resolve(repoPath))) throw new Error('Path traversal not allowed');
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content as string, 'utf-8');
        return { written: true, path: filePath };
      },
    },
    {
      name: 'list_directory',
      description: 'List files and directories at a path in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to repository root (use "." for root)' },
          recursive: { type: 'boolean', description: 'If true, list all files recursively (default: false)' },
        },
        required: ['path'],
      },
      handler: async ({ path: dirPath, recursive = false }) => {
        const full = path.resolve(repoPath, dirPath as string);
        if (!full.startsWith(path.resolve(repoPath))) throw new Error('Path traversal not allowed');
        if (!fs.existsSync(full)) return { error: `Directory not found: ${dirPath}` };

        if (recursive) {
          const files: string[] = [];
          const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const rel = path.relative(repoPath, path.join(dir, entry.name));
              if (entry.name === 'node_modules' || entry.name === '.git') continue;
              if (entry.isDirectory()) walk(path.join(dir, entry.name));
              else files.push(rel);
            }
          };
          walk(full);
          return { files };
        }

        const entries = fs.readdirSync(full, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return { entries };
      },
    },
    {
      name: 'search_code',
      description: 'Search for a text pattern across all files in the repository',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          fileGlob: { type: 'string', description: 'Optional glob to limit search (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
      handler: async ({ pattern, fileGlob }) => {
        const results: { file: string; line: number; text: string }[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (fileGlob && !entry.name.match(String(fileGlob).replace('*', '.*'))) continue;
            try {
              const lines = fs.readFileSync(full, 'utf-8').split('\n');
              const re = new RegExp(pattern as string, 'i');
              lines.forEach((l, i) => {
                if (re.test(l)) results.push({ file: path.relative(repoPath, full), line: i + 1, text: l.trim() });
              });
            } catch { /* binary file */ }
            if (results.length >= 50) return;
          }
        };
        walk(repoPath);
        return { results: results.slice(0, 50), truncated: results.length >= 50 };
      },
    },
  ];
}
