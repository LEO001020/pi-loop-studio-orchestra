// Node's synchronous module hook prevents accidental success from importing
// the harness's ancestor node_modules. It is dependency hygiene, NOT an OS
// sandbox: arbitrary code can still change its environment or use fs directly.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';

const root=process.env.PI_LOOP_WORKTREE;
if(!root||!path.isAbsolute(root))throw new Error('PI_LOOP_WORKTREE is required for task dependency resolution');
const npmRoot=path.resolve(import.meta.dirname,'../.runtime/node-home/node_modules/npm');
function inside(base,file){
  const relative=path.relative(base,file);
  return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
registerHooks({resolve(specifier,context,nextResolve){
  const result=nextResolve(specifier,context);
  if(!result.url?.startsWith('file:'))return result;
  // node --test/Worker can preload this same hook through both NODE_OPTIONS
  // and inherited execArgv. Permit this exact idempotent module, not server/.
  if(result.url===import.meta.url)return result;
  const resolved=fileURLToPath(result.url);
  if(inside(root,resolved))return result;
  const parent=context.parentURL?.startsWith('file:')?fileURLToPath(context.parentURL):null;
  // The bundled package manager needs its own libraries to install the task's
  // dependencies. Task imports may not use that exception as a library path.
  if(inside(npmRoot,resolved)&&(!parent||inside(npmRoot,parent)))return result;
  const error=new Error(`DEPENDENCY_OUTSIDE_WORKTREE: ${specifier} resolved outside this task. Declare and install the dependency in this project's package.json/lockfile; do not rely on Pi Loop's own packages. Resolved: ${resolved}`);
  error.code='DEPENDENCY_OUTSIDE_WORKTREE';throw error;
}});
