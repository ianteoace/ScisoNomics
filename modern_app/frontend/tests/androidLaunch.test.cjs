const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{test}=require('node:test');
const root=path.resolve(__dirname,'..');
const {prepareAndroidRuntime,files}=require('../../scripts/prepare-android-runtime.cjs');
test('Android launch preparation is idempotent, survives regeneration and never changes signing, manifests or icons',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sciso-launch-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'AndroidManifest.xml'),'manifest-unchanged');fs.writeFileSync(path.join(dir,'keystore.properties'),'synthetic-untouched');
 prepareAndroidRuntime(dir);const contents=files.map(([,to])=>fs.readFileSync(path.join(dir,to)));prepareAndroidRuntime(dir);
 files.forEach(([,to],i)=>assert(fs.readFileSync(path.join(dir,to)).equals(contents[i])));
 assert.equal(fs.readFileSync(path.join(dir,'AndroidManifest.xml'),'utf8'),'manifest-unchanged');
 assert.equal(fs.readFileSync(path.join(dir,'keystore.properties'),'utf8'),'synthetic-untouched');
});
test('native launch has Android 12 system splash and bounded fallback; warm resume and intents remain inherited',()=>{
 const source=fs.readFileSync(path.join(root,'src-tauri/android-runtime/MainActivity.kt'),'utf8');
 assert.match(source,/Build.VERSION.SDK_INT >= 31/);assert.match(source,/setOnExitAnimationListener/);
 assert.match(source,/savedInstanceState == null/);assert.match(source,/areAnimatorsEnabled/);
 assert.match(source,/500L/);assert.match(source,/120L/);assert.match(source,/splash.remove\(\)/);
 assert.doesNotMatch(source,/override fun onResume|override fun onNewIntent|setKeepOnScreenCondition|purchase|token|clearData/);
 const theme=fs.readFileSync(path.join(root,'src-tauri/android-runtime/res/values-v31/themes.xml'),'utf8');
 assert.match(theme,/windowSplashScreenBackground/);assert.match(theme,/@mipmap\/ic_launcher_foreground/);
});
