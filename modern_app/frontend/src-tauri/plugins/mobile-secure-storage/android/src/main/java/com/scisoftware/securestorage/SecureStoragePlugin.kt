package com.scisoftware.securestorage

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
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
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing != null) return existing as SecretKey
        check(create) // Missing/inaccessible key never triggers plaintext or silent recovery.
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun read(file: AtomicFile, accountId: String): String? {
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
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(2, 14)))
        cipher.updateAAD(accountId.toByteArray(Charsets.UTF_8))
        val plaintext = cipher.doFinal(bytes.copyOfRange(14, bytes.size))
        return try { String(plaintext, Charsets.UTF_8).also { validateToken(it) } }
            finally { plaintext.fill(0) }
    }

    private fun validateToken(token: String) {
        require(token.isNotEmpty() && token.length <= 4096 && token.none { it.isWhitespace() })
    }

    private fun execute(invoke: Invoke, action: (TokenArgs) -> JSObject) {
        worker.execute {
            try { invoke.resolve(action(invoke.parseArgs(TokenArgs::class.java))) }
            catch (_: Exception) { invoke.reject("mobile_secure_storage_failed") }
        }
    }

    private fun write(file: AtomicFile, accountId: String, token: String) {
        // If a record exists, missing key material is an error; do not overwrite it.
        val secretKey = key(!file.baseFile.exists())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        check(cipher.iv.size == 12)
        cipher.updateAAD(accountId.toByteArray(Charsets.UTF_8))
        val plaintext = token.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        val output = file.startWrite()
        try {
            output.write(byteArrayOf(1, 12) + cipher.iv + encrypted)
            file.finishWrite(output)
        } catch (error: Exception) { file.failWrite(output); throw error }
        check(read(file, accountId) == token)
    }

    private fun identityRecord(accountKey: String): AtomicFile {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(accountKey))
        val dir = File(activity.noBackupFilesDir, "device_identities")
        check(dir.isDirectory || dir.mkdirs())
        return AtomicFile(File(dir, "$accountKey.bin"))
    }

    // Internal Rust bridge only. No corresponding Rust JS commands or permissions.
    // The separate directory and AAD prevent the refresh-token API reading/replacing keys.
    @Command
    fun saveIdentity(invoke: Invoke) = execute(invoke) { args ->
        val value = requireNotNull(args.token)
        validateToken(value)
        write(identityRecord(args.accountId), "device-identity:${args.accountId}", value)
        JSObject().apply { put("ok", true) }
    }

    @Command
    fun loadIdentity(invoke: Invoke) = execute(invoke) { args ->
        val value = read(identityRecord(args.accountId), "device-identity:${args.accountId}")
        JSObject().apply { put("value", value ?: org.json.JSONObject.NULL) }
    }

    @Command
    fun deleteIdentity(invoke: Invoke) = execute(invoke) { args ->
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
