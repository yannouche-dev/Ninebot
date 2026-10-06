package com.example.ninebote3.protocol

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

class ClassicNbCrypto {
    companion object {
        val FW_DATA: ByteArray = byteArrayOf(
            0x97.toByte(), 0xCF.toByte(), 0xB8.toByte(), 0x02,
            0x84.toByte(), 0x41, 0x43, 0xDE.toByte(),
            0x56, 0x00, 0x2B, 0x3B, 0x34, 0x78, 0x0A, 0x5D
        )
    }

    private var name = ByteArray(0)
    private var sha1Key = ByteArray(16)
    private var bleData: ByteArray? = null
    private var appData: ByteArray? = null
    var iteration: Int = 0
        private set

    fun setName(value: ByteArray) {
        name = value.copyOf()
        sha1Key = calcSha1Key(name, FW_DATA)
        bleData = null
        appData = null
        iteration = 0
    }

    fun setBleData(value: ByteArray) {
        bleData = value.copyOf()
        sha1Key = calcSha1Key(name, value)
    }

    fun setAppData(value: ByteArray) {
        val ble = bleData ?: ByteArray(0)
        appData = value.copyOf()
        sha1Key = calcSha1Key(value, ble)
    }

    fun encrypt(data: ByteArray): ByteArray {
        require(data.size >= 3)

        val payload = data.copyOfRange(3, data.size)

        return if (iteration == 0 || bleData == null) {
            val crc = crc16(payload)
            val enc = cryptoNext(payload, sha1Key, null)

            data.copyOfRange(0, 3) +
                enc +
                byteArrayOf(
                    0x00, 0x00,
                    crc[0], crc[1],
                    0x00, 0x00
                )
        } else {
            iteration += 1

            val aesData = genAesData()
            val enc = cryptoNext(payload, sha1Key, aesData)

            aesData[0] = 0x59
            aesData[15] = payload.size.toByte()
            val crc = crcNext(data, sha1Key, aesData)

            data.copyOfRange(0, 3) +
                enc +
                crc +
                byteArrayOf(
                    ((iteration shr 8) and 0xff).toByte(),
                    (iteration and 0xff).toByte()
                )
        }
    }

    fun decrypt(data: ByteArray): ByteArray {
        require(data.size >= 9)

        val result = ByteArray(data.size - 6)
        data.copyOfRange(0, 3).copyInto(result, 0)

        val payloadLength = data.size - 9
        val payload = data.copyOfRange(3, 3 + payloadLength)

        iteration =
            ((data[data.size - 2].toInt() and 0xff) shl 8) or
                (data[data.size - 1].toInt() and 0xff)

        val decoded =
            if (iteration == 0 || bleData == null) {
                cryptoNext(payload, sha1Key, null)
            } else {
                cryptoNext(payload, sha1Key, genAesData())
            }

        decoded.copyInto(result, 3)
        return result
    }

    private fun genAesData(): ByteArray {
        val result = ByteArray(16)
        result[0] = 1
        result[1] = ((iteration shr 24) and 0xff).toByte()
        result[2] = ((iteration shr 16) and 0xff).toByte()
        result[3] = ((iteration shr 8) and 0xff).toByte()
        result[4] = (iteration and 0xff).toByte()

        val ble = bleData ?: ByteArray(0)
        for (i in 0 until minOf(8, ble.size)) {
            result[5 + i] = ble[i]
        }

        result[15] = 0
        return result
    }

    private fun crcNext(
        data: ByteArray,
        key: ByteArray,
        aesData: ByteArray
    ): ByteArray {
        var aesKey = aesEcbEncrypt(aesData, key)

        var xorData1 = ByteArray(16)
        data.copyOfRange(0, minOf(3, data.size)).copyInto(xorData1, 0)

        var xorData2 = aesKey.copyOf()
        var xored = xor(xorData1, xorData2, 16)
        aesKey = aesEcbEncrypt(xored, key)
        xorData2 = aesKey.copyOf()

        var remaining = data.size - 3
        var byteIndex = 3

        while (remaining > 0) {
            val count = minOf(remaining, 16)
            xorData1 = ByteArray(16)
            data.copyInto(
                destination = xorData1,
                destinationOffset = 0,
                startIndex = byteIndex,
                endIndex = byteIndex + count
            )

            xored = xor(xorData1, xorData2, 16)
            aesKey = aesEcbEncrypt(xored, key)
            xorData2 = aesKey.copyOf()

            remaining -= count
            byteIndex += count
        }

        aesData[0] = 1
        aesData[15] = 0
        aesKey = aesEcbEncrypt(aesData, key)

        for (i in 0 until 4) {
            xorData1[i] = aesKey[i]
        }

        return xor(xorData1, xorData2, 4)
    }

    private fun cryptoNext(
        input: ByteArray,
        key: ByteArray,
        aesData: ByteArray?
    ): ByteArray {
        val result = ByteArray(input.size)
        var byteIndex = 0
        var remaining = input.size

        while (remaining > 0) {
            val count = minOf(remaining, 16)
            val xorData1 = ByteArray(16)

            input.copyInto(
                destination = xorData1,
                destinationOffset = 0,
                startIndex = byteIndex,
                endIndex = byteIndex + count
            )

            val aesKey =
                if (aesData == null) {
                    aesEcbEncrypt(FW_DATA, key)
                } else {
                    aesData[15] =
                        ((aesData[15].toInt() and 0xff) + 1).toByte()
                    aesEcbEncrypt(aesData, key)
                }

            val xored = xor(xorData1, aesKey, 16)
            xored.copyInto(
                destination = result,
                destinationOffset = byteIndex,
                startIndex = 0,
                endIndex = count
            )

            remaining -= count
            byteIndex += count
        }

        return result
    }

    private fun calcSha1Key(
        first: ByteArray,
        second: ByteArray
    ): ByteArray {
        val data = ByteArray(32)

        first.copyInto(
            destination = data,
            destinationOffset = 0,
            startIndex = 0,
            endIndex = minOf(16, first.size)
        )

        second.copyInto(
            destination = data,
            destinationOffset = 16,
            startIndex = 0,
            endIndex = minOf(16, second.size)
        )

        return MessageDigest
            .getInstance("SHA-1")
            .digest(data)
            .copyOfRange(0, 16)
    }

    private fun crc16(data: ByteArray): ByteArray {
        val value =
            data.sumOf { it.toInt() and 0xff }
                .inv() and 0xffff

        return byteArrayOf(
            (value and 0xff).toByte(),
            ((value shr 8) and 0xff).toByte()
        )
    }

    private fun aesEcbEncrypt(
        data: ByteArray,
        key: ByteArray
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/ECB/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES")
        )
        return cipher.doFinal(data)
    }

    private fun xor(
        first: ByteArray,
        second: ByteArray,
        size: Int
    ): ByteArray =
        ByteArray(size) { index ->
            (first[index].toInt() xor second[index].toInt()).toByte()
        }
}
