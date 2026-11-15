use anyhow::{anyhow, Result};
use zeroize::Zeroizing;

use crate::platform;

pub const KEYCHAIN_SERVICE: &str = "opencode-bot";
const INDEX_ACCOUNT: &str = "__opencode_bot_index__";

pub fn is_valid_secret_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn encode_stored_value(value: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        // Match legacy src/secrets.ts Keychain encoding (`security add-generic-password -X` stores hex ASCII).
        hex_encode(value.as_bytes())
    }
    #[cfg(not(target_os = "macos"))]
    {
        value.to_string()
    }
}

fn decode_stored_value(raw: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        if let Some(decoded) = hex_decode(raw) {
            if let Ok(text) = String::from_utf8(decoded) {
                return text;
            }
        }
        raw.to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        raw.to_string()
    }
}

#[cfg(target_os = "macos")]
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(target_os = "macos")]
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn validate_name(name: &str) -> Result<()> {
    if !is_valid_secret_name(name) {
        return Err(anyhow!(
            "Invalid secret name {name:?}: use 1..64 chars of [A-Za-z0-9._-]"
        ));
    }
    Ok(())
}

pub fn save_secret(name: &str, value: &str) -> Result<()> {
    validate_name(name)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name)?;
    let stored = Zeroizing::new(encode_stored_value(value));
    entry.set_password(&stored)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = update_index_add(name);
    }
    Ok(())
}

pub fn read_secret(name: &str) -> Result<Option<Zeroizing<String>>> {
    validate_name(name)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name)?;
    match entry.get_password() {
        Ok(raw) => {
            let raw_z = Zeroizing::new(raw);
            let decoded = Zeroizing::new(decode_stored_value(&raw_z));
            Ok(Some(decoded))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow!("Failed to read secret {name:?}: {err}")),
    }
}

pub fn delete_secret(name: &str) -> Result<bool> {
    validate_name(name)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name)?;
    let deleted = match entry.delete_credential() {
        Ok(()) => true,
        Err(keyring::Error::NoEntry) => false,
        Err(err) => return Err(anyhow!("Failed to delete secret {name:?}: {err}")),
    };
    #[cfg(not(target_os = "macos"))]
    {
        let _ = update_index_remove(name);
    }
    Ok(deleted)
}

pub fn has_secrets(names: &[String]) -> std::collections::HashMap<String, bool> {
    let mut map = std::collections::HashMap::with_capacity(names.len());
    #[cfg(target_os = "macos")]
    {
        let accounts: std::collections::HashSet<String> =
            list_macos_keychain_accounts().into_iter().collect();
        for name in names {
            let exists = is_valid_secret_name(name) && accounts.contains(name);
            map.insert(name.clone(), exists);
        }
        return map;
    }
    #[cfg(not(target_os = "macos"))]
    {
        for name in names {
            if !is_valid_secret_name(name) {
                map.insert(name.clone(), false);
                continue;
            }
            let exists = keyring::Entry::new(KEYCHAIN_SERVICE, name)
                .and_then(|e| e.get_password())
                .is_ok();
            map.insert(name.clone(), exists);
        }
        map
    }
}

pub fn list_secret_names() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut names: Vec<String> = list_macos_keychain_accounts()
            .into_iter()
            .filter(|n| n != INDEX_ACCOUNT && is_valid_secret_name(n))
            .collect();
        names.sort();
        names.dedup();
        return names;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut names = read_index();
        names.retain(|n| {
            n != INDEX_ACCOUNT
                && is_valid_secret_name(n)
                && keyring::Entry::new(KEYCHAIN_SERVICE, n)
                    .and_then(|e| e.get_password())
                    .is_ok()
        });
        names.sort();
        names.dedup();
        names
    }
}

pub fn type_secret(name: &str) -> Result<()> {
    let secret = read_secret(name)?
        .ok_or_else(|| anyhow!("Secret {name:?} does not exist in OS keychain"))?;
    platform::inject_text(&secret)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn read_index() -> Vec<String> {
    let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, INDEX_ACCOUNT) else {
        return Vec::new();
    };
    match entry.get_password() {
        Ok(raw) => serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

#[cfg(not(target_os = "macos"))]
fn write_index(names: &[String]) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, INDEX_ACCOUNT)?;
    let json = serde_json::to_string(names)?;
    entry.set_password(&json)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn update_index_add(name: &str) -> Result<()> {
    let mut names = read_index();
    if !names.iter().any(|n| n == name) {
        names.push(name.to_string());
        names.sort();
        write_index(&names)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn update_index_remove(name: &str) -> Result<()> {
    let mut names = read_index();
    let before = names.len();
    names.retain(|n| n != name);
    if names.len() != before {
        write_index(&names)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn list_macos_keychain_accounts() -> Vec<String> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecItemCopyMatching(query: *const c_void, result: *mut *const c_void) -> i32;
        static kSecClass: *const c_void;
        static kSecClassGenericPassword: *const c_void;
        static kSecAttrService: *const c_void;
        static kSecMatchLimit: *const c_void;
        static kSecMatchLimitAll: *const c_void;
        static kSecReturnAttributes: *const c_void;
    }

    unsafe {
        let keys = [
            CFString::wrap_under_get_rule(kSecClass.cast()),
            CFString::wrap_under_get_rule(kSecAttrService.cast()),
            CFString::wrap_under_get_rule(kSecMatchLimit.cast()),
            CFString::wrap_under_get_rule(kSecReturnAttributes.cast()),
        ];
        let svc = CFString::new(KEYCHAIN_SERVICE);
        let vals = [
            CFType::wrap_under_get_rule(kSecClassGenericPassword),
            svc.as_CFType(),
            CFType::wrap_under_get_rule(kSecMatchLimitAll),
            CFBoolean::true_value().as_CFType(),
        ];
        let query = CFDictionary::from_CFType_pairs(&[
            (keys[0].clone(), vals[0].clone()),
            (keys[1].clone(), vals[1].clone()),
            (keys[2].clone(), vals[2].clone()),
            (keys[3].clone(), vals[3].clone()),
        ]);
        let mut out_ptr: *const c_void = std::ptr::null();
        let status = SecItemCopyMatching(query.as_concrete_TypeRef().cast(), &mut out_ptr);
        if status != 0 || out_ptr.is_null() {
            return Vec::new();
        }
        let arr = core_foundation::array::CFArray::<CFDictionary>::wrap_under_create_rule(
            out_ptr.cast(),
        );
        let acct_key = CFString::new("acct");
        let mut accounts = Vec::new();
        for item in arr.iter() {
            if let Some(val_ptr) = item.find(acct_key.as_concrete_TypeRef().cast::<c_void>()) {
                let s = CFString::wrap_under_get_rule((*val_ptr).cast()).to_string();
                accounts.push(s);
            }
        }
        accounts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_name_validation() {
        assert!(is_valid_secret_name("github_token"));
        assert!(is_valid_secret_name("my.key-1"));
        assert!(!is_valid_secret_name(""));
        assert!(!is_valid_secret_name("bad name"));
        assert!(!is_valid_secret_name("bad/name"));
    }
}
