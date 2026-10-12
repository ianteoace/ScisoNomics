// Build gate: no keys are written or printed. Next receives the existing local
// secure environment, then native Android builds consume ONLY the verified out.
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../frontend'), output = path.resolve(root, 'out');
const required = {
 NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL: 'https://scisonomics-production-d8a3.up.railway.app',
 NEXT_PUBLIC_SUPABASE_URL: 'https://egwxtvroruvjwhpizbeg.supabase.co',
};
function validateEnvironment(env) {
 for(const [name,expected] of Object.entries(required)) if(env[name]?.replace(/\/$/,'')!==expected) throw new Error(`Production build requires ${name} for the production project.`);
 if(!env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) throw new Error('Production publishable key is missing; provide it locally without pasting it into logs.');
}
function verifyOutput(dir = output) {
 const markers = {stagingApi:'https://marvelous-intuition-staging.up.railway.app',stagingSupabase:'https://ktfrqbghsrfmfkzzapkh.supabase.co',productionApi:required.NEXT_PUBLIC_SCISONOMICS_CLOUD_API_URL,productionSupabase:required.NEXT_PUBLIC_SUPABASE_URL};
 const counts = Object.fromEntries(Object.keys(markers).map(key=>[key,0]));
 function scan(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw new Error('Unexpected link in export.');if(entry.isDirectory())scan(file);else{const content=fs.readFileSync(file,'utf8');for(const[key,url]of Object.entries(markers))counts[key]+=content.split(url).length-1;}}}
 scan(dir);
 if(counts.stagingApi||counts.stagingSupabase||!counts.productionApi||!counts.productionSupabase) throw new Error('Export does not satisfy production isolation checks. No Android bundle should be built.');
 return counts;
}
function main(){
 if(!process.argv.includes('--verify-only')) {
  process.env.NODE_ENV='production';
  require(path.join(root,'node_modules/@next/env')).loadEnvConfig(root,false,{info(){},error(){throw new Error('Could not load local build environment.');}});
  validateEnvironment(process.env);
  if(path.dirname(output)!==root||path.basename(output)!=='out'||(fs.existsSync(output)&&fs.lstatSync(output).isSymbolicLink()))throw new Error('Unsafe export path.');
  fs.rmSync(output,{recursive:true,force:true});
  const result=spawnSync(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build'],{cwd:root,env:{...process.env,NEXT_PUBLIC_SCISONOMICS_MOBILE_ACCOUNT_RECOVERY:'1'},stdio:'inherit'});
  if(result.status!==0)throw new Error('Frontend build failed; Android bundle is blocked.');
 }
 console.info('Production export isolation OK:',JSON.stringify(verifyOutput()));
}
module.exports={validateEnvironment,verifyOutput};
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
