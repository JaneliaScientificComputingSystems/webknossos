package security

import com.scalableminds.util.Msg
import com.scalableminds.util.tools.{Fox, FoxImplicits, JsonHelper}
import com.scalableminds.webknossos.datastore.rpc.RPC
import com.typesafe.scalalogging.LazyLogging
import play.api.libs.json.{JsObject, Json, OFormat}
import pdi.jwt.JwtJson
import play.api.libs.ws._
import utils.WkConf

import java.math.BigInteger
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.spec.RSAPublicKeySpec
import java.security.{KeyFactory, MessageDigest, PublicKey, SecureRandom}
import java.util.Base64
import javax.inject.Inject
import scala.concurrent.ExecutionContext

class OpenIdConnectClient @Inject()(rpc: RPC, conf: WkConf)(implicit ec: ExecutionContext)
    extends FoxImplicits
    with LazyLogging {

  private val keyTypeRsa = "RSA"

  private lazy val oidcConfig: OpenIdConnectConfig =
    OpenIdConnectConfig(
      conf.SingleSignOn.OpenIdConnect.providerUrl,
      conf.SingleSignOn.OpenIdConnect.clientId,
      if (conf.SingleSignOn.OpenIdConnect.clientSecret.nonEmpty) Some(conf.SingleSignOn.OpenIdConnect.clientSecret)
      else None,
      conf.SingleSignOn.OpenIdConnect.scope,
    )

  /*
   Build redirect URL to redirect to OIDC provider for auth request (https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)
   Returns (authorization URL, PKCE code_verifier, opaque state token). The
   caller is responsible for carrying the verifier and state across the
   redirect (e.g. via short-lived cookies), passing the verifier back to
   getAndValidateTokens, and verifying that the state echoed by the OP
   matches the one originally sent (CSRF defense).
   */
  def getRedirectUrl(callbackUrl: String): Fox[(String, String, String)] = {
    val codeVerifier = newPkceCodeVerifier()
    val codeChallenge = pkceCodeChallenge(codeVerifier)
    val state = newRandomState()
    for {
      _ <- Fox.fromBool(conf.Features.openIdConnectEnabled) ?~> Msg.Oidc.notEnabled
      _ <- Fox.fromBool(oidcConfig.isValid) ?~> Msg.Oidc.configurationInvalid
      redirectUrl <- discover.map { serverInfos =>
        def queryParams: Map[String, String] = Map(
          "client_id" -> oidcConfig.clientId,
          "redirect_uri" -> callbackUrl,
          "scope" -> oidcConfig.scope,
          "response_type" -> "code",
          "code_challenge" -> codeChallenge,
          "code_challenge_method" -> "S256",
          "state" -> state,
        )
        serverInfos.authorization_endpoint + "?" +
          queryParams.map(v => v._1 + "=" + URLEncoder.encode(v._2, StandardCharsets.UTF_8.toString)).mkString("&")
      }
    } yield (redirectUrl, codeVerifier, state)
  }

  /*
  Fetches token from the oidc provider (https://openid.net/specs/openid-connect-core-1_0.html#TokenRequest),
  fields described by https://www.rfc-editor.org/rfc/rfc6749#section-4.4.2
  Note that some providers will also reply with an id token next to the auth token, which is also returned as an option.
   */
  def getAndValidateTokens(redirectUrl: String,
                           code: String,
                           codeVerifier: String): Fox[(JsObject, Option[JsObject])] =
    for {
      _ <- Fox.fromBool(conf.Features.openIdConnectEnabled) ?~> Msg.Oidc.notEnabled
      _ <- Fox.fromBool(oidcConfig.isValid) ?~> Msg.Oidc.configurationInvalid
      serverInfos <- discover
      tokenResponse <- rpc(serverInfos.token_endpoint)
        .silentIf(!conf.SingleSignOn.OpenIdConnect.verboseLoggingEnabled)
        .withBasicAuthOpt(Some(oidcConfig.clientId), oidcConfig.clientSecret)
        .postFormWithJsonResponse[OpenIdConnectTokenResponse](
          Map(
            "grant_type" -> "authorization_code",
            "redirect_uri" -> redirectUrl,
            "code" -> code,
            "code_verifier" -> codeVerifier,
            "scope" -> oidcConfig.scope
          ))
      _ = logDebug(
        s"Fetched oidc token for scope '${oidcConfig.scope}', response scope: ${tokenResponse.scope}. Decoding...")
      (accessToken, idToken) <- validateOpenIdConnectTokenResponse(tokenResponse, serverInfos) ?~> "failed to parse JWT"
      _ = logDebug(s"Got id token $idToken and access token $accessToken.")
    } yield (accessToken, idToken)

  /*
  Discover endpoints of the provider (https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig)
   */
  private def discover: Fox[OpenIdConnectProviderInfo] =
    for {
      response: WSResponse <- rpc(oidcConfig.discoveryUrl)
        .silentIf(!conf.SingleSignOn.OpenIdConnect.verboseLoggingEnabled)
        .get
      serverInfo <- JsonHelper.as[OpenIdConnectProviderInfo](response.json).toFox
    } yield serverInfo

  private def validateOpenIdConnectTokenResponse(
      tokenResponse: OpenIdConnectTokenResponse,
      serverInfos: OpenIdConnectProviderInfo): Fox[(JsObject, Option[JsObject])] =
    for {
      publicKey <- fetchServerPublicKey(serverInfos)
      decdoedAccessToken <- JwtJson.decodeJson(tokenResponse.access_token, publicKey).toFox
      decodedIdToken: Option[JsObject] <- Fox.runOptional(tokenResponse.id_token)(idToken =>
        JwtJson.decodeJson(idToken, publicKey).toFox)
    } yield (decdoedAccessToken, decodedIdToken)

  private def fetchServerPublicKey(serverInfos: OpenIdConnectProviderInfo): Fox[PublicKey] =
    for {
      response: WSResponse <- rpc(serverInfos.jwks_uri)
        .silentIf(!conf.SingleSignOn.OpenIdConnect.verboseLoggingEnabled)
        .get
      jsonWebKeySet: JsonWebKeySet <- JsonHelper.as[JsonWebKeySet](response.json).toFox
      firstRsaKey: JsonWebKey <- jsonWebKeySet.keys
        .find(key => key.kty == keyTypeRsa && key.use == "sig")
        .toFox ?~> "No server RSA Public Key found in server key set"
      modulusString <- firstRsaKey.n.toFox
      modulus = new BigInteger(1, Base64.getUrlDecoder.decode(modulusString.getBytes))
      exponentString <- firstRsaKey.e.toFox
      exponent = new BigInteger(1, Base64.getUrlDecoder.decode(exponentString.getBytes))
      publicKeySpec = new RSAPublicKeySpec(modulus, exponent)
      publicKey = KeyFactory.getInstance(keyTypeRsa).generatePublic(publicKeySpec)
    } yield publicKey

  private def logDebug(message: String): Unit = if (conf.SingleSignOn.OpenIdConnect.verboseLoggingEnabled) {
    logger.info(message)
  }

  // PKCE per RFC 7636. 32 random bytes → 43-character base64url-without-padding
  // verifier (within the spec's 43–128 character range).
  private val pkceVerifierBytes = 32
  private val pkceRng = new SecureRandom()
  private val base64UrlNoPad = Base64.getUrlEncoder.withoutPadding

  private def newPkceCodeVerifier(): String = {
    val bytes = new Array[Byte](pkceVerifierBytes)
    pkceRng.nextBytes(bytes)
    base64UrlNoPad.encodeToString(bytes)
  }

  private def pkceCodeChallenge(verifier: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.UTF_8))
    base64UrlNoPad.encodeToString(digest)
  }

  // Opaque random state token for CSRF defense. Some OPs (Okta) reject the
  // authorization request when state is absent.
  private def newRandomState(): String = {
    val bytes = new Array[Byte](32)
    pkceRng.nextBytes(bytes)
    base64UrlNoPad.encodeToString(bytes)
  }
}

// Fields as specified by https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata
case class OpenIdConnectProviderInfo(
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: String,
    jwks_uri: String
)

object OpenIdConnectProviderInfo {
  implicit val format: OFormat[OpenIdConnectProviderInfo] = Json.format[OpenIdConnectProviderInfo]
}

case class OpenIdConnectConfig(
    baseUrl: String,
    clientId: String,
    clientSecret: Option[String],
    scope: String
) {

  lazy val discoveryUrl: String = baseUrl + ".well-known/openid-configuration"

  def isValid: Boolean =
    baseUrl.nonEmpty
}

// Fields as specified by https://www.rfc-editor.org/rfc/rfc6749#section-5.1
case class OpenIdConnectTokenResponse(
    access_token: String,
    id_token: Option[String],
    token_type: String,
    refresh_token: Option[String],
    scope: Option[String]
)

object OpenIdConnectTokenResponse {
  implicit val format: OFormat[OpenIdConnectTokenResponse] = Json.format[OpenIdConnectTokenResponse]
}

// Claims as specified by https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims
case class OpenIdConnectUserInfo(given_name: String, family_name: String, email: String)
object OpenIdConnectUserInfo {
  implicit val format: OFormat[OpenIdConnectUserInfo] = Json.format[OpenIdConnectUserInfo]
}

case class JsonWebKeySet(keys: Seq[JsonWebKey])
object JsonWebKeySet {
  implicit val jsonFormat: OFormat[JsonWebKeySet] = Json.format[JsonWebKeySet]
}

// Specified by https://datatracker.ietf.org/doc/html/rfc7517#section-4
// and RSA-specific by https://datatracker.ietf.org/doc/html/rfc7518#section-6.3.1
case class JsonWebKey(
    kty: String, // key type
    alg: String, // algorithm
    use: String, // usage (sig for signature or enc for encryption)
    n: Option[String], // rsa modulus
    e: Option[String] // rsa exponent
)

object JsonWebKey {
  implicit val jsonFormat: OFormat[JsonWebKey] = Json.format[JsonWebKey]
}
