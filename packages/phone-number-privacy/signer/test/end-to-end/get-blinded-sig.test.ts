import { newKitFromWeb3 } from '@celo/contractkit'
import {
  KEY_VERSION_HEADER,
  PnpQuotaResponse,
  rootLogger,
  SignerEndpoint,
  SignMessageResponseFailure,
  SignMessageResponseSuccess,
  TestUtils,
} from '@celo/phone-number-privacy-common'
import { serializeSignature, signMessage } from '@celo/utils/lib/signatureUtils'
import threshold_bls from 'blind-threshold-bls'
import { randomBytes } from 'crypto'
import 'isomorphic-fetch'
import Web3 from 'web3'
import { getWalletAddress } from '../../src/common/web3/contracts'
import { config, getSignerVersion } from '../../src/config'

require('dotenv').config()

const {
  ACCOUNT_ADDRESS1,
  ACCOUNT_ADDRESS2,
  ACCOUNT_ADDRESS3,
  BLINDED_PHONE_NUMBER,
  IDENTIFIER,
  PHONE_NUMBER,
  PRIVATE_KEY1,
  PRIVATE_KEY2,
  PRIVATE_KEY3,
} = TestUtils.Values
const { replenishQuota, registerWalletAddress, getBlindedPhoneNumber } = TestUtils.Utils

const ODIS_SIGNER = process.env.ODIS_SIGNER_SERVICE_URL
const ODIS_PUBLIC_POLYNOMIAL = process.env[
  process.env.ODIS_PNP_POLYNOMIAL_VAR_FOR_TESTS as string
] as string
const ODIS_KEY_VERSION = (process.env.ODIS_PNP_TEST_KEY_VERSION || 1) as string
// Keep these checks as is to ensure backwards compatibility
const SIGN_MESSAGE_ENDPOINT = '/getBlindedMessagePartialSig'
const GET_QUOTA_ENDPOINT = '/getQuota'

const DEFAULT_FORNO_URL = process.env.ODIS_BLOCKCHAIN_PROVIDER as string

const web3 = new Web3(new Web3.providers.HttpProvider(DEFAULT_FORNO_URL))
const contractkit = newKitFromWeb3(web3)
contractkit.addAccount(PRIVATE_KEY1)
contractkit.addAccount(PRIVATE_KEY2)
contractkit.addAccount(PRIVATE_KEY3)

jest.setTimeout(30000)

const getRandomBlindedPhoneNumber = () => {
  return getBlindedPhoneNumber(PHONE_NUMBER, randomBytes(32))
}

describe('Running against a deployed service', () => {
  beforeAll(() => {
    console.log('FORNO_URL: ' + DEFAULT_FORNO_URL)
    console.log('ODIS_SIGNER: ' + ODIS_SIGNER)
    console.log('ODIS_PUBLIC_POLYNOMIAL: ' + ODIS_PUBLIC_POLYNOMIAL)
    console.log('ODIS_KEY_VERSION:' + ODIS_KEY_VERSION)
  })

  it('Service is deployed at correct version', async () => {
    const response = await fetch(ODIS_SIGNER + SignerEndpoint.STATUS, { method: 'GET' })
    const body = await response.json()
    // This checks against local package.json version, change if necessary
    expect(response.status).toBe(200)
    expect(body.version).toBe(getSignerVersion())
  })

  describe('Returns status 400 with invalid input', () => {
    it('With invalid address', async () => {
      const response = await postToSignMessage(BLINDED_PHONE_NUMBER, '0x1234', Date.now(), 'ignore')
      expect(response.status).toBe(400)
    })

    it('With missing blindedQueryPhoneNumber', async () => {
      const response = await postToSignMessage('', ACCOUNT_ADDRESS1, Date.now())
      expect(response.status).toBe(400)
    })

    it('With invalid blindedQueryPhoneNumber', async () => {
      const response = await postToSignMessage('invalid', ACCOUNT_ADDRESS1, Date.now())
      expect(response.status).toBe(400)
    })
  })

  describe('Returns status 401 with invalid authentication headers', () => {
    it('With invalid auth header', async () => {
      const response = await postToSignMessage(
        BLINDED_PHONE_NUMBER,
        ACCOUNT_ADDRESS1,
        Date.now(),
        'invalid'
      )
      expect(response.status).toBe(401)
    })

    it('With auth header signer mismatch', async () => {
      // Sign body with different account
      const body = JSON.stringify({
        hashedPhoneNumber: '+1455556600',
        blindedQueryPhoneNumber: BLINDED_PHONE_NUMBER.trim(),
        ACCOUNT_ADDRESS1,
      })
      const signature = signMessage(JSON.stringify(body), PRIVATE_KEY2, ACCOUNT_ADDRESS2)
      const authHeader = serializeSignature(signature)

      const response = await postToSignMessage(
        BLINDED_PHONE_NUMBER,
        ACCOUNT_ADDRESS1,
        undefined,
        authHeader
      )
      expect(response.status).toBe(401)
    })
  })

  it('Returns 403 error when querying out of quota', async () => {
    const response = await postToSignMessage(
      getRandomBlindedPhoneNumber(),
      ACCOUNT_ADDRESS1,
      Date.now()
    )
    expect(response.status).toBe(403)
  })

  describe('When account address has enough quota', () => {
    // if these tests are failing, it may just be that the address needs to be fauceted:
    // celotooljs account faucet --account ACCOUNT_ADDRESS2 --dollar 1 --gold 1 -e <ENV> --verbose

    beforeAll(async () => {
      console.log('ACCOUNT_ADDRESS1 ' + ACCOUNT_ADDRESS1)
      console.log('ACCOUNT_ADDRESS2 ' + ACCOUNT_ADDRESS2)
      console.log('ACCOUNT_ADDRESS3 ' + ACCOUNT_ADDRESS3)

      contractkit.defaultAccount = ACCOUNT_ADDRESS2
    })

    it('Returns sig when querying succeeds', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const response = await postToSignMessage(BLINDED_PHONE_NUMBER, ACCOUNT_ADDRESS2)
      expect(response.status).toBe(200)
    })

    // Backwards compatibility check
    it('Returns sig when querying succeeds w/ expired timestamp', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const response = await postToSignMessage(
        BLINDED_PHONE_NUMBER,
        ACCOUNT_ADDRESS2,
        Date.now() - 10 * 60 * 1000
      ) // 10 minutes ago
      expect(response.status).toBe(200)
    })

    it('Increments query count when querying succeeds w/ unused request', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const initialQueryCount = await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)
      await postToSignMessage(getRandomBlindedPhoneNumber(), ACCOUNT_ADDRESS2)
      expect(initialQueryCount).toEqual((await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)) - 1)
    })

    // Backwards compatibility check
    it('Increments query count when querying succeeds w/ timestamp', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const initialQueryCount = await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)
      await postToSignMessage(getRandomBlindedPhoneNumber(), ACCOUNT_ADDRESS2, Date.now())
      expect(initialQueryCount).toEqual((await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)) - 1)
    })

    it('Returns sig when querying succeeds with replayed request without incrementing query count', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const blindedPhoneNumber = getRandomBlindedPhoneNumber()
      const res1 = await postToSignMessage(blindedPhoneNumber, ACCOUNT_ADDRESS2)
      expect(res1.status).toBe(200)
      const queryCount = await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)
      const res2 = await postToSignMessage(blindedPhoneNumber, ACCOUNT_ADDRESS2)
      expect(res2.status).toBe(200)
      expect(queryCount).toEqual(await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER))
    })

    // Backwards compatibility check
    it('Returns sig when querying succeeds with replayed request without incrementing query count w/ timestamp', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const res1 = await postToSignMessage(BLINDED_PHONE_NUMBER, ACCOUNT_ADDRESS2, Date.now())
      expect(res1.status).toBe(200)
      const queryCount = await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER)
      const res2 = await postToSignMessage(BLINDED_PHONE_NUMBER, ACCOUNT_ADDRESS2, Date.now())
      expect(res2.status).toBe(200)
      expect(queryCount).toEqual(await getQueryCount(ACCOUNT_ADDRESS2, IDENTIFIER))
    })
  })

  describe('When walletAddress has enough quota', () => {
    // if these tests are failing, it may just be that the address needs to be fauceted:
    // celotooljs account faucet --account ACCOUNT_ADDRESS2 --dollar 1 --gold 1 -e <ENV> --verbose
    // NOTE: DO NOT FAUCET ACCOUNT_ADDRESS3
    let initialQuota: number
    let initialQueryCount: number
    beforeAll(async () => {
      contractkit.defaultAccount = ACCOUNT_ADDRESS3
      await registerWalletAddress(ACCOUNT_ADDRESS3, ACCOUNT_ADDRESS2, PRIVATE_KEY2, contractkit)
      // ACCOUNT_ADDRESS2 is now the wallet address (has quota)
      // and ACCOUNT_ADDRESS3 is account address (does not have quota on it's own, only bc of walletAddress)
      initialQuota = await getQuota(ACCOUNT_ADDRESS3, IDENTIFIER)
      initialQueryCount = await getQueryCount(ACCOUNT_ADDRESS3, IDENTIFIER)
    })

    it('Check that accounts are set up correctly', async () => {
      expect(await getQuota(ACCOUNT_ADDRESS2, IDENTIFIER)).toBeLessThan(initialQuota)
      expect(
        await getWalletAddress(
          contractkit,
          rootLogger(config.serviceName),
          ACCOUNT_ADDRESS3,
          SignerEndpoint.LEGACY_PNP_SIGN
        )
      ).toBe(ACCOUNT_ADDRESS2)
    })

    // Note: Use this test to check the signers' key configuration. Modify .env to try out different
    // key/version combinations
    it('Returns sig when querying succeeds with unused request', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const blindedPhoneNumber = getRandomBlindedPhoneNumber()
      const response = await postToSignMessage(blindedPhoneNumber, ACCOUNT_ADDRESS3)
      expect(response.status).toBe(200)

      // Validate signature
      type SignerResponse = SignMessageResponseSuccess | SignMessageResponseFailure
      const data = await response.text()
      const signResponse = JSON.parse(data) as SignerResponse
      expect(signResponse.success).toBeTruthy()
      if (signResponse.success) {
        const sigBuffer = Buffer.from(signResponse.signature as string, 'base64')
        const isValid = isValidSignature(sigBuffer, blindedPhoneNumber, ODIS_PUBLIC_POLYNOMIAL)
        expect(isValid).toBeTruthy()
      }
    })

    it('Returns count when querying with unused request increments query count', async () => {
      const queryCount = await getQueryCount(ACCOUNT_ADDRESS3, IDENTIFIER)
      expect(queryCount).toEqual(initialQueryCount + 1)
    })

    it('Returns sig when querying succeeds with used request', async () => {
      await replenishQuota(ACCOUNT_ADDRESS2, contractkit)
      const response = await postToSignMessage(BLINDED_PHONE_NUMBER, ACCOUNT_ADDRESS3)
      expect(response.status).toBe(200)
    })

    it('Returns count when querying with used request does not increment query count', async () => {
      const queryCount = await getQueryCount(ACCOUNT_ADDRESS3, IDENTIFIER)
      expect(queryCount).toEqual(initialQueryCount + 1)
    })
  })
})

async function getQuota(
  account: string,
  hashedPhoneNumber?: string,
  authHeader?: string
): Promise<number> {
  const res = await queryQuotaEndpoint(account, hashedPhoneNumber, authHeader)
  return res.success ? res.totalQuota ?? 0 : 0
}

async function getQueryCount(
  account: string,
  hashedPhoneNumber?: string,
  authHeader?: string
): Promise<number> {
  const res = await queryQuotaEndpoint(account, hashedPhoneNumber, authHeader)
  return res.success ? res.performedQueryCount ?? 0 : 0
}

async function queryQuotaEndpoint(
  account: string,
  hashedPhoneNumber?: string,
  authHeader?: string
): Promise<PnpQuotaResponse> {
  const body = JSON.stringify({
    account,
    hashedPhoneNumber,
  })

  const authorization = authHeader || (await contractkit.connection.sign(body, account))

  const res = await fetch(ODIS_SIGNER + GET_QUOTA_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization,
    },
    body,
  })

  return res.json()
}

async function postToSignMessage(
  base64BlindedMessage: string,
  account: string,
  timestamp?: number,
  authHeader?: string,
  keyVersion: string = ODIS_KEY_VERSION
): Promise<Response> {
  const body = JSON.stringify({
    hashedPhoneNumber: IDENTIFIER,
    blindedQueryPhoneNumber: base64BlindedMessage.trim(),
    account,
    timestamp,
  })

  const authorization = authHeader || (await contractkit.connection.sign(body, account))

  const res = await fetch(ODIS_SIGNER + SIGN_MESSAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization,
      [KEY_VERSION_HEADER]: keyVersion,
    },
    body,
  })

  return res
}

function isValidSignature(signature: Buffer, blindedMessage: string, polynomial: string) {
  try {
    threshold_bls.partialVerifyBlindSignature(
      Buffer.from(polynomial, 'hex'),
      Buffer.from(blindedMessage, 'base64'),
      signature
    )
    return true
  } catch (err) {
    console.log(err)
    return false
  }
}
