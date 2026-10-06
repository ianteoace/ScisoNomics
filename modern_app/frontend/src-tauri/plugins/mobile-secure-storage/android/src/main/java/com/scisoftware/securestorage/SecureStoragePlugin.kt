package com.scisoftware.securestorage

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class TokenArgs {
    var accountId: String = ""
    var token: String? = null
}

@TauriPlugin
class SecureStoragePlugin(private val activity: Activity) : Plugin(activity) {
    // A serialized worker avoids blocking the UI, key-creation races and late writes.
    private val worker = Executors.newSingleThreadExecutor()
    private val alias = "scisonomics.supabase.refresh.v1"
    private var identityStage: String? = null // Accessed only on the serialized worker.

    private fun identityTrace(stage: String, detail: String = "") {
        if (identityStage == null) return
        identityStage = stage
        if ((activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            Log.i("ScisoSecureStorage", "stage=$stage $detail")
        }
    }

    private fun record(accountId: String): AtomicFile {
        require(Regex("^[a-fA-F0-9]{64}::[A-Za-z0-9_-]{1,120}$").matches(accountId))
        require(accountId.substringAfter("::") != "local")
        val dir = File(activity.noBackupFilesDir, "supabase_refresh")
        check(dir.isDirectory || dir.mkdirs())
        val name = MessageDigest.getInstance("SHA-256").digest(accountId.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return AtomicFile(File(dir, "$name.bin"))
    }

    private fun key(create: Boolean): SecretKey {
        identityTrace("keystore_lookup", "create=$create")
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        identityTrace("keystore_key", "present=${existing != null}")
        if (existing != null) return existing as SecretKey
        if (!create) identityTrace("keystore_key_missing")
        check(create) // Missing/inaccessible key never triggers plaintext or silent recovery.
        identityTrace("keystore_generate")
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun read(file: AtomicFile, accountId: String): String? {
        identityTrace("read_blob", "exists=${file.baseFile.exists()}")
        // openRead recovers AtomicFile's interrupted-write state, when applicable.
        val bytes = try { file.openRead().use { stream ->
            check(stream.channel.size() in 30..8192)
            stream.readBytes()
        } }
            catch (e: java.io.FileNotFoundException) {
                check(!file.baseFile.exists())
                return null
            }
        check(bytes.size in 30..8192 && bytes[0].toInt() == 1 && bytes[1].toInt() == 12)
        identityTrace("validate_blob", "length=${bytes.size}")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(2, 14)))
        cipher.updateAAD(accountId.toByteArray(Charsets.UTF_8))
        identityTrace("decrypt_blob")
        val plaintext = cipher.doFinal(bytes.copyOfRange(14, bytes.size))
        return try { String(plaintext, Charsets.UTF_8).also { validateToken(it) } }
            finally { plaintext.fill(0) }
    }

    private fun validateToken(token: String) {
        require(token.isNotEmpty() && token.length <= 4096 && token.none { it.isWhitespace() })
    }

    private fun execute(invoke: Invoke, identityOperation: String? = null, action: (TokenArgs) -> JSObject) {
        worker.execute {
            identityStage = identityOperation
            try { invoke.resolve(action(invoke.parseArgs(TokenArgs::class.java))) }
            catch (error: Exception) {
                identityTrace(identityStage ?: "invoke", "error_type=${error.javaClass.simpleName}")
                invoke.reject("mobile_secure_storage_failed")
            } finally { identityStage = null }
        }
    }

    private fun write(file: AtomicFile, accountId: String, token: String) {
        // If a record exists, missing key material is an error; do not overwrite it.
        val secretKey = key(!file.baseFile.exists())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        check(cipher.iv.size == 12)
        cipher.updateAAD(accountId.toByteArray(Charsets.UTF_8))
        identityTrace("encrypt_blob", "plaintext_length=${token.length}")
        val plaintext = token.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        identityTrace("atomic_write")
        val output = file.startWrite()
        try {
            output.write(byteArrayOf(1, 12) + cipher.iv + encrypted)
            file.finishWrite(output)
        } catch (error: Exception) { file.failWrite(output); throw error }
        identityTrace("roundtrip_read")
        check(read(file, accountId) == token)
        identityTrace("roundtrip_verified")
    }

    private fun identityRecord(accountKey: String): AtomicFile {
        identityTrace("validate_account_key", "length=${accountKey.length}")
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(accountKey))
        identityTrace("identity_directory")
        val dir = File(activity.noBackupFilesDir, "device_identities")
        check(dir.isDirectory || dir.mkdirs())
        return AtomicFile(File(dir, "$accountKey.bin"))
    }

    // Internal Rust bridge only. No corresponding Rust JS commands or permissions.
    // The separate directory and AAD prevent the refresh-token API reading/replacing keys.
    @Command
    fun saveIdentity(invoke: Invoke) = execute(invoke, "save_identity") { args ->
        val value = requireNotNull(args.token)
        validateToken(value)
        write(identityRecord(args.accountId), "device-identity:${args.accountId}", value)
        JSObject().apply { put("ok", true) }
    }

    @Command
    fun loadIdentity(invoke: Invoke) = execute(invoke, "load_identity") { args ->
        val value = read(identityRecord(args.accountId), "device-identity:${args.accountId}")
        JSObject().apply { put("value", value ?: org.json.JSONObject.NULL) }
    }

    @Command
    fun deleteIdentity(invoke: Invoke) = execute(invoke, "delete_identity") { args ->
        val file = identityRecord(args.accountId)
        file.delete()
        check(read(file, "device-identity:${args.accountId}") == null)
        JSObject().apply { put("ok", true) }
    }

    @Command
    fun save(invoke: Invoke) = execute(invoke) { args ->
        val token = requireNotNull(args.token)
        validateToken(token)
        val file = record(args.accountId)
        write(file, args.accountId, token)
        JSObject().apply { put("ok", true); put("roundtrip", true) }
    }

    @Command
    fun load(invoke: Invoke) = execute(invoke) { args ->
        val token = read(record(args.accountId), args.accountId)
        JSObject().apply { put("found", token != null); put("token", token ?: org.json.JSONObject.NULL) }
    }

    @Command
    fun delete(invoke: Invoke) = execute(invoke) { args ->
        val file = record(args.accountId)
        file.delete()
        check(read(file, args.accountId) == null)
        JSObject().apply { put("ok", true) }
    }
}
