#!/Users/lattenero/.local/bin/nu-nightly
# One-time, idempotent: the STABLE local code-signing identity.
#
# Why: the fork installs ad-hoc signed (`codesign --sign -`), so the macOS
# Keychain sees every build as a DIFFERENT app and asks for the login
# password ("ZCode wants to use your confidential information stored in
# Chromium Safe Storage"). A self-signed certificate trusted for code
# signing gives every build the SAME designated requirement — one
# «Siempre permitir» and the prompt never comes back.
#
# Creates the key+cert with openssl, imports the identity into the login
# keychain pre-authorizing /usr/bin/codesign, and trusts the cert for
# codeSigning in the USER domain (no sudo, no admin password). Idempotent:
# an existing valid identity is left untouched.

const IDENTITY: string = "ZCode Local Signing"
const KEYCHAIN: string = "/Users/lattenero/Library/Keychains/login.keychain-db"
const WORKDIR: string = "/tmp/zcode-signing"
const P12_PASS: string = "zcode-local"

def identity-exists []: nothing -> bool {
    let r: record = (do { ^security find-identity -v -p codesigning } | complete)
    ($r.stdout | str contains $IDENTITY)
}

def checked [label: string, cmd: closure]: nothing -> nothing {
    let r: record = (do $cmd | complete)
    if $r.exit_code != 0 {
        rm -rf $WORKDIR
        error make {msg: $"($label) failed: ($r.stderr | str trim)"}
    }
}

def main []: nothing -> nothing {
    if (identity-exists) {
        print $"[identity] «($IDENTITY)» already present — nothing to do"
        print (^security find-identity -v -p codesigning | lines | str join (char nl))
        return
    }
    rm -rf $WORKDIR
    mkdir $WORKDIR
    let key: string = ($WORKDIR | path join "key.pem")
    let cert: string = ($WORKDIR | path join "cert.pem")
    let p12: string = ($WORKDIR | path join "identity.p12")
    let cnf: string = ($WORKDIR | path join "openssl.cnf")
    [
        "[req]"
        "prompt = no"
        "distinguished_name = dn"
        "x509_extensions = ext"
        ""
        "[dn]"
        $"CN = ($IDENTITY)"
        ""
        "[ext]"
        "basicConstraints = critical,CA:FALSE"
        "keyUsage = critical,digitalSignature"
        "extendedKeyUsage = critical,codeSigning"
        "subjectKeyIdentifier = hash"
    ] | str join (char nl) | save -f $cnf
    checked "openssl req" { ^openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -keyout $key -out $cert -config $cnf }
    # LEGACY P12 ALGORITHMS: `security import` rejects the modern MAC
    # ("MAC verification failed") — PBE-SHA1-3DES + SHA1 MAC are the shape
    # macOS accepts (the known LibreSSL/OpenSSL 3 interop fix).
    checked "openssl pkcs12" { ^openssl pkcs12 -export -out $p12 -inkey $key -in $cert -passout $"pass:($P12_PASS)" -name $IDENTITY -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 }
    checked "security import" { ^security import $p12 -k $KEYCHAIN -P $P12_PASS -T /usr/bin/codesign -T /usr/bin/security }
    checked "add-trusted-cert" { ^security add-trusted-cert -r trustRoot -p codeSign -k $KEYCHAIN $cert }
    rm -rf $WORKDIR
    if not (identity-exists) {
        error make {msg: "the identity is not listed as valid — inspect: security find-identity -v -p codesigning"}
    }
    print $"[identity] «($IDENTITY)» created and valid:"
    print (^security find-identity -v -p codesigning | lines | str join (char nl))
    print "[identity] install-zip now signs with it — the next fork install stops the Keychain prompts"
}
