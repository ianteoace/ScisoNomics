const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
globalThis.window = undefined;
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop:true }, fileName:filename,
}).outputText,filename);

const identity={formatVersion:1,deviceId:"00112233-4455-6677-8899-aabbccddeeff",publicKey:"test-public-key",publicKeyHash:"test-public-hash"};
const challenge={challengeId:"10213243-5465-7687-98a9-babbdcddedef",nonce:"test-nonce",issuedAt:100,expiresAt:220,familyId:null,targetDeviceId:null,requestHash:null};
const user={id:"internal-owner",email:"test@example.com"};
class RequestError extends Error { constructor(message,options={}) { super(message);Object.assign(this,options); } }
function stub(file,exports) { const filename=path.join(root,file);require.cache[filename]={id:filename,filename,loaded:true,exports}; }

function setup(t,platform="android") {
  const store=new Map(), calls=[], native=[];
  const ctx={ trusted:false,mode:"enforce",wrongOwner:false,revoked:false,calls,native,store };
  t.mock.property(globalThis,"window",{ navigator:{userAgent:platform==="android"?"Android":platform==="ios"?"iPhone":"Windows NT"},
    localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},
    __TAURI_INTERNALS__:{invoke:async (command,args)=>{
      native.push({command,args});
      if(command==="get_or_create_account_device_identity") return {identity};
      if(command.startsWith("sign_")) return {...identity,signature:"test-signature"};
      throw new Error("Unexpected private command");
    }} });
  stub("lib/supabase.ts",{getSupabaseProjectUrl:()=>"https://identity.test"});
  const grant=()=>({user:ctx.wrongOwner?{...user,id:"supabase-sub"}:user,access_token:"device-grant",expires_in:900,deviceId:identity.deviceId,familyId:"ffeeddcc-bbaa-9988-7766-554433221100",accountBinding:"test-binding"});
  stub("services/cloudAuth.ts",{CloudAuthRequestError:RequestError,cloudRequest:async (route,options)=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({route,body,headers:options.headers});
    if(route.endsWith("/context"))return {userId:user.id,accountBinding:"test-binding",mode:ctx.mode};
    if(route.endsWith("/login"))return ctx.trusted?{status:"trusted",challenge}:{status:"pending_verification",verificationId:"otp-id",verificationToken:"memory-continuation",expiresIn:600,resendAvailableIn:60};
    if(route.endsWith("/enrollment/challenge"))return challenge;
    if(route.endsWith("/resend"))return {status:"pending_verification",verificationId:"replacement-id",verificationToken:"replacement-continuation",expiresIn:600,resendAvailableIn:60};
    if(route.endsWith("/refresh/challenge")) { if(ctx.revoked)throw new RequestError("Revoked",{code:"device_revoked",kind:"auth"});return {...challenge,familyId:body.familyId}; }
    if(route.endsWith("/management/challenge"))return {...challenge,familyId:body.familyId,targetDeviceId:body.targetDeviceId,requestHash:body.name?"server-name-hash":null};
    if(route.endsWith("/management/complete"))return {ok:true,currentRevoked:body.confirmCurrent};
    if(route.endsWith("/complete"))return grant();
    if(route==="/auth/devices")return {devices:[{device_id:identity.deviceId,device_name:"Teléfono",platform:"android",status:"trusted",current:true}]};
    throw new Error("Unexpected protocol route");
  }});
  delete require.cache[path.join(root,"services/deviceAuthorization.ts")];
  ctx.api=require("../services/deviceAuthorization.ts");
  return ctx;
}

for(const platform of ["desktop","android"])test(`${platform} unknown device returns continuation only, with no persisted session`,async t=>{
  const ctx=setup(t,platform), result=await ctx.api.beginDeviceLogin("primary-token",user);
  assert.equal(result.enrollment.status,"pending_verification");
  assert.equal(result.grant,undefined);assert.equal(ctx.store.size,0);
  assert.equal(ctx.calls.at(-1).body.platform,platform==="desktop"?"windows":"android");
  assert.equal(ctx.native.length,1);assert.equal(ctx.native[0].command,"get_or_create_account_device_identity");
  assert.ok(ctx.calls.every(c=>!c.body?.userId&&!c.body?.ownerId));
});

test("trusted login requires native DeviceAuthentication proof, without an OTP",async t=>{
  const ctx=setup(t);ctx.trusted=true;
  const result=await ctx.api.beginDeviceLogin("primary-token",user);
  assert.equal(result.grant.user.id,"internal-owner");
  assert.equal(ctx.native.at(-1).command,"sign_device_authentication_proof");
  assert.equal(ctx.calls.at(-1).route,"/auth/devices/authentication/complete");
  assert.ok(!ctx.calls.some(c=>c.route.includes("enrollment")));
});

test("OTP submits enrollment proof; only non-secret authorized metadata is persisted",async t=>{
  const ctx=setup(t), result=await ctx.api.beginDeviceLogin("primary-token",user);
  const grant=await ctx.api.completeDeviceEnrollment("primary-token",result.context,result.enrollment,"123456");
  assert.equal(ctx.native.at(-1).command,"sign_device_enrollment_proof");
  assert.equal(ctx.calls.at(-1).body.code,"123456");
  assert.ok(ctx.native.every(c=>!JSON.stringify(c.args).includes("123456")));
  assert.equal(ctx.store.size,0);
  ctx.api.rememberDeviceGrant(user.id,grant);
  assert.doesNotMatch([...ctx.store.values()].join(""),/primary-token|device-grant|123456|continuation|publicKey|signature|nonce|private/);
});

test("invalid format makes no OTP request; resend sends only the in-memory continuation",async t=>{
  const ctx=setup(t), result=await ctx.api.beginDeviceLogin("primary-token",user), before=ctx.calls.length;
  await assert.rejects(ctx.api.completeDeviceEnrollment("primary-token",result.context,result.enrollment,"wrong"),e=>e.code==="device_otp_invalid");
  assert.equal(ctx.calls.length,before);
  const replacement=await ctx.api.resendDeviceEnrollment("primary-token",result.enrollment);
  assert.equal(replacement.verificationId,"replacement-id");
  assert.deepEqual(Object.keys(ctx.calls.at(-1).body).sort(),["verificationId","verificationToken"]);
  assert.equal(ctx.store.size,0);
});

test("restore uses Refresh purpose with the authorized family, and rejects revocation",async t=>{
  const ctx=setup(t);ctx.trusted=true;
  const {grant}=await ctx.api.beginDeviceLogin("primary-token",user);
  ctx.api.rememberDeviceGrant(user.id,grant);
  assert.equal((await ctx.api.restoreDeviceGrant("rotated-primary",user.id)).user.id,user.id);
  assert.equal(ctx.native.at(-1).command,"sign_refresh_proof");
  assert.equal(ctx.native.at(-1).args.challenge.familyId,grant.familyId);
  ctx.revoked=true;
  await assert.rejects(ctx.api.restoreDeviceGrant("rotated-primary",user.id),e=>e.code==="device_revoked");
});

test("off server, mismatched internal owner and iOS storage fail closed",async t=>{
  const ctx=setup(t);ctx.mode="off";
  await assert.rejects(ctx.api.beginDeviceLogin("primary-token",user),e=>e.code==="device_verification_unavailable");
  assert.equal(ctx.native.length,0);
  ctx.mode="enforce";ctx.trusted=true;ctx.wrongOwner=true;
  await assert.rejects(ctx.api.beginDeviceLogin("primary-token",user),e=>e.code==="internal_identity_mismatch");
  window.navigator.userAgent="iPhone";
  await assert.rejects(ctx.api.beginDeviceLogin("primary-token",user),e=>e.code==="device_storage_unavailable");
});

test("rename/revoke use management proof, signed target and explicit current confirmation",async t=>{
  const ctx=setup(t);ctx.trusted=true;
  const {grant}=await ctx.api.beginDeviceLogin("primary-token",user);ctx.api.rememberDeviceGrant(user.id,grant);
  await ctx.api.manageAccountDevice("device-grant",user.id,identity.deviceId,"device_rename","Mi teléfono");
  assert.equal(ctx.native.at(-1).args.purpose,"device_rename");
  assert.equal(ctx.native.at(-1).args.challenge.targetDeviceId,identity.deviceId);
  assert.equal(ctx.calls.at(-1).body.name,"Mi teléfono");
  const result=await ctx.api.manageAccountDevice("device-grant",user.id,identity.deviceId,"device_revoke",undefined,true);
  assert.equal(result.currentRevoked,true);assert.equal(ctx.calls.at(-1).body.confirmCurrent,true);
  assert.equal(ctx.native.at(-1).args.purpose,"device_revoke");
  ctx.api.forgetDeviceGrant(user.id);
  await assert.rejects(ctx.api.restoreDeviceGrant("primary-token",user.id),e=>e.code==="device_verification_required");
  assert.ok(!ctx.native.some(c=>c.command.includes("delete_account_device_identity")));
});

test("identity bridge has no JS permission or native fallback for private material",()=>{
  const rust=fs.readFileSync(path.join(root,"src-tauri/plugins/mobile-secure-storage/src/lib.rs"),"utf8");
  const capabilities=fs.readFileSync(path.join(root,"src-tauri/capabilities/mobile-auth.json"),"utf8");
  assert.match(rust,/generate_handler!\[save, load, delete\]/);
  assert.match(rust,/mobile_secure_command_not_available/);
  assert.doesNotMatch(capabilities,/identity|private|sign/);
  const lib=fs.readFileSync(path.join(root,"src-tauri/src/lib.rs"),"utf8");
  assert.match(lib,/identity_load\(app/);assert.match(lib,/spawn_blocking/);
});
