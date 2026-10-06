package com.example.ninebote3.protocol

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

class NinebotCryptoV2(private val gen2: Boolean = true) {
    companion object {
        val FW_DATA: ByteArray = byteArrayOf(
            0x97.toByte(), 0xCF.toByte(), 0xB8.toByte(), 0x02,
            0x84.toByte(), 0x41, 0x43, 0xDE.toByte(),
            0x56, 0x00, 0x2B, 0x3B, 0x34, 0x78, 0x0A, 0x5D
        )

        const val SUCCESS = 0
        const val ERR_AUTH = -2
        const val ERR_REPLAY = -3
    }

    private var aesKey = deriveKey(byteArrayOf(), null)
    private var auth = ByteArray(16)
    private val ecbInput = if (gen2) FW_DATA.copyOf() else ByteArray(16)
    private var counter = 0
    private var snMode = false
    private var lastRxCounter = -1

    fun setKey(key1: ByteArray, key2: ByteArray?) {
        aesKey = deriveKey(key1, key2)
    }

    fun setAuth(value: ByteArray) {
        auth = value.copyOf(16)
    }

    fun resetSn() {
        counter = 0
        snMode = false
        lastRxCounter = -1
    }

    fun startSn() {
        counter = 1
        snMode = true
        lastRxCounter = -1
    }

    fun encrypt(plaintext: ByteArray): ByteArray {
        if (!snMode) return encryptNonSn(plaintext)

        counter += 1
        val ctr = counter
        val nonce = buildNonce(ctr, auth)
        val payload = plaintext.copyOfRange(3, plaintext.size)
        val rawTag = cbcMac(plaintext, nonce)

        val ciphertext = ByteArray(payload.size)
        var offset = 0
        var blockIndex = 1
        while (offset < payload.size) {
            val count = minOf(16, payload.size - offset)
            val counterBlock = ByteArray(16)
            counterBlock[0] = 0x01
            nonce.copyInto(counterBlock, 1)
            counterBlock[14] = 0x00
            counterBlock[15] = blockIndex.toByte()
            val stream = aesEcb(aesKey, counterBlock)
            for (i in 0 until count) {
                ciphertext[offset + i] =
                    (payload[offset + i].toInt() xor stream[i].toInt()).toByte()
            }
            offset += count
            blockIndex++
        }

        val a0Block = ByteArray(16)
        a0Block[0] = 0x01
        nonce.copyInto(a0Block, 1)
        val a0 = aesEcb(aesKey, a0Block)
        val encTag = ByteArray(4) { i ->
            (rawTag[i].toInt() xor a0[i].toInt()).toByte()
        }

        return plaintext.copyOfRange(0, 3) +
            ciphertext +
            encTag +
            byteArrayOf(((ctr shr 8) and 0xff).toByte(), (ctr and 0xff).toByte())
    }

    fun decrypt(data: ByteArray): Pair<ByteArray, Int> {
        if (data.size < 9) return byteArrayOf() to ERR_AUTH

        val header = data.copyOfRange(0, 3)
        val ctr = ((data[data.size - 2].toInt() and 0xff) shl 8) or
            (data[data.size - 1].toInt() and 0xff)
        val receivedTag = data.copyOfRange(data.size - 6, data.size - 2)
        val payload = data.copyOfRange(3, data.size - 6)

        if (ctr == 0) {
            val stream = aesEcb(aesKey, ecbInput)
            val plain = ByteArray(payload.size)
            var offset = 0
            while (offset < payload.size) {
                val count = minOf(16, payload.size - offset)
                for (i in 0 until count) {
                    plain[offset + i] =
                        (payload[offset + i].toInt() xor stream[i].toInt()).toByte()
                }
                offset += count
            }
            return (header + plain) to SUCCESS
        }

        if (ctr <= lastRxCounter) return byteArrayOf() to ERR_REPLAY

        val nonce = buildNonce(ctr, auth)
        val plainPayload = ByteArray(payload.size)
        var offset = 0
        var blockIndex = 1
        while (offset < payload.size) {
            val count = minOf(16, payload.size - offset)
            val counterBlock = ByteArray(16)
            counterBlock[0] = 0x01
            nonce.copyInto(counterBlock, 1)
            counterBlock[14] = 0x00
            counterBlock[15] = blockIndex.toByte()
            val stream = aesEcb(aesKey, counterBlock)
            for (i in 0 until count) {
                plainPayload[offset + i] =
                    (payload[offset + i].toInt() xor stream[i].toInt()).toByte()
            }
            offset += count
            blockIndex++
        }

        val plaintext = header + plainPayload

        val a0Block = ByteArray(16)
        a0Block[0] = 0x01
        nonce.copyInto(a0Block, 1)
        val a0 = aesEcb(aesKey, a0Block)
        val expectedRawTag = ByteArray(4) { i ->
            (receivedTag[i].toInt() xor a0[i].toInt()).toByte()
        }

        if (!cbcMac(plaintext, nonce).contentEquals(expectedRawTag)) {
            return byteArrayOf() to ERR_AUTH
        }

        lastRxCounter = ctr
        return plaintext to SUCCESS
    }

    private fun encryptNonSn(plaintext: ByteArray): ByteArray {
        val payload = plaintext.copyOfRange(3, plaintext.size)
        val checksum = payload.sumOf { it.toInt() and 0xff }.inv() and 0xffff
        val stream = aesEcb(aesKey, ecbInput)

        val ciphertext = ByteArray(payload.size)
        var offset = 0
        while (offset < payload.size) {
            val count = minOf(16, payload.size - offset)
            for (i in 0 until count) {
                ciphertext[offset + i] =
                    (payload[offset + i].toInt() xor stream[i].toInt()).toByte()
            }
            offset += count
        }

        return plaintext.copyOfRange(0, 3) +
            ciphertext +
            byteArrayOf(
                0x00, 0x00,
                (checksum and 0xff).toByte(),
                ((checksum shr 8) and 0xff).toByte(),
                0x00, 0x00
            )
    }

    private fun cbcMac(plaintext: ByteArray, nonce: ByteArray): ByteArray {
        val payload = plaintext.copyOfRange(3, plaintext.size)

        val b0 = ByteArray(16)
        b0[0] = 0x59
        nonce.copyInto(b0, 1)
        b0[14] = 0x00
        b0[15] = payload.size.toByte()

        var x = aesEcb(aesKey, b0)

        val aad = ByteArray(16)
        plaintext.copyOfRange(0, 3).copyInto(aad, 0)
        x = aesEcb(aesKey, xor(x, aad))

        var offset = 0
        while (offset < payload.size) {
            val block = ByteArray(16)
            val count = minOf(16, payload.size - offset)
            payload.copyInto(block, 0, offset, offset + count)
            x = aesEcb(aesKey, xor(x, block))
            offset += count
        }

        return x.copyOfRange(0, 4)
    }

    private fun buildNonce(counter: Int, auth: ByteArray): ByteArray {
        val nonce = ByteArray(13)
        nonce[0] = ((counter shr 24) and 0xff).toByte()
        nonce[1] = ((counter shr 16) and 0xff).toByte()
        nonce[2] = ((counter shr 8) and 0xff).toByte()
        nonce[3] = (counter and 0xff).toByte()
        auth.copyOf(8).copyInto(nonce, 4)
        nonce[12] = 0x00
        return nonce
    }

    private fun deriveKey(key1: ByteArray, key2: ByteArray?): ByteArray {
        val buffer = ByteArray(32)
        key1.copyOf(minOf(16, key1.size)).copyInto(buffer, 0)
        key2?.copyOf(minOf(16, key2.size))?.copyInto(buffer, 16)
        return MessageDigest.getInstance("SHA-1").digest(buffer).copyOfRange(0, 16)
    }

    private fun aesEcb(key: ByteArray, block: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/ECB/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        return cipher.doFinal(block)
    }

    private fun xor(a: ByteArray, b: ByteArray): ByteArray =
        ByteArray(minOf(a.size, b.size)) { i ->
            (a[i].toInt() xor b[i].toInt()).toByte()
        }
}
