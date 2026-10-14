// Reapply tracked launch customization after Tauri regenerates gen/android.
// Explicit file list only: never touch signing files, Gradle, icons or manifests.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../frontend/src-tauri');
const source=path.join(root,'android-runtime'),target=path.join(root,'gen/android/app/src/main');
const files=[['MainActivity.kt','java/com/scisoftware/scisonomics/MainActivity.kt'],
  ['res/values/themes.xml','res/values/themes.xml'],['res/values/themes.xml','res/values-night/themes.xml'],
  ['res/values-v31/themes.xml','res/values-v31/themes.xml'],['res/values-v31/themes.xml','res/values-night-v31/themes.xml'],
  ['res/drawable/sciso_launch_background.xml','res/drawable/sciso_launch_background.xml']];
function prepareAndroidRuntime(destination=target){
  if(!fs.existsSync(path.join(destination,'AndroidManifest.xml')))throw new Error('Initialize the Android project with Tauri before preparing launch assets.');
  for(const [from,to] of files){
    const file=path.resolve(destination,to);
    if(!file.startsWith(path.resolve(destination)+path.sep))throw new Error('Unsafe Android launch asset path.');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new Error('Android launch asset must not be a symlink.');
    const data=fs.readFileSync(path.join(source,from));
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(!fs.existsSync(file)||!fs.readFileSync(file).equals(data))fs.writeFileSync(file,data);
  }
}
if(require.main===module){prepareAndroidRuntime();console.info('Android launch assets prepared.');}
module.exports={prepareAndroidRuntime,files};
