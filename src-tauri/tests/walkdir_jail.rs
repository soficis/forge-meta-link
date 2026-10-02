use forge_meta_link_lib::scanner::{is_within_jail, scan_directory};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(prefix: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let pid = std::process::id();
    std::env::temp_dir().join(format!("fml_{}_{}_{}", prefix, pid, nanos))
}

#[test]
fn walkdir_jail_is_within_jail_rejects_parent_traversal() {
    // is_within_jail expects canonical inputs; callers canonicalize before checking.
    // Verify canonical child under root passes, sibling and canonicalized outside fail.
    assert!(is_within_jail(
        Path::new("/tmp/jail_root"),
        Path::new("/tmp/jail_root/sub/file.png")
    ));
    assert!(!is_within_jail(
        Path::new("/tmp/jail_root"),
        Path::new("/tmp/jail_root_other/file.png")
    ));
    // Simulate canonicalized traversal: /tmp/jail_root/../etc/passwd canonicalizes to /tmp/etc/passwd which is outside
    assert!(!is_within_jail(
        Path::new("/tmp/jail_root"),
        Path::new("/tmp/etc/passwd")
    ));
    assert!(!is_within_jail(
        Path::new("/tmp/a/b"),
        Path::new("/tmp/a/c/file.png")
    ));
    // Prefix attack: /tmp/jail_root_evil must not be considered inside /tmp/jail_root
    assert!(!is_within_jail(
        Path::new("/tmp/jail_root"),
        Path::new("/tmp/jail_root_evil/file.png")
    ));
}

#[test]
fn walkdir_jail_symlink_outside_root_is_excluded() {
    let root = temp_root("jail_root");
    let outside = temp_root("jail_outside");
    let _ = fs::create_dir_all(&root);
    let _ = fs::create_dir_all(&outside);
    let outside_file = outside.join("secret.png");
    let _ = fs::write(&outside_file, b"fake png");
    let inside_file = root.join("inside.png");
    let _ = fs::write(&inside_file, b"inside png");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link_path = root.join("link_to_outside.png");
        let _ = symlink(&outside_file, &link_path);
    }
    #[cfg(windows)]
    {
        let link_path = root.join("link_to_outside.png");
        let _ = std::os::windows::fs::symlink_file(&outside_file, &link_path);
    }

    let results = scan_directory(&root);
    let found_outside = results.iter().any(|f| {
        f.path
            .canonicalize()
            .map(|p| p == outside_file.canonicalize().unwrap_or(outside_file.clone()))
            .unwrap_or(false)
    });
    let found_inside = results.iter().any(|f| f.path == inside_file);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(!found_outside, "symlink to outside file must be jailed");
    assert!(found_inside, "inside file must be found");
}

#[test]
fn walkdir_jail_symlink_dir_outside_root_not_traversed() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        + 7;
    let pid = std::process::id();
    let root = std::env::temp_dir().join(format!("fml_jail_root_dir_{}_{}", pid, nanos));
    let outside = std::env::temp_dir().join(format!("fml_jail_outside_dir_{}_{}", pid, nanos));
    let _ = fs::create_dir_all(&root);
    let _ = fs::create_dir_all(&outside);
    let outside_file = outside.join("evil.png");
    let _ = fs::write(&outside_file, b"evil");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link_dir = root.join("linkdir");
        let _ = symlink(&outside, &link_dir);
    }
    #[cfg(windows)]
    {
        let link_dir = root.join("linkdir");
        let _ = std::os::windows::fs::symlink_dir(&outside, &link_dir);
    }
    let results = scan_directory(&root);
    let found_evil = results.iter().any(|f| f.path.ends_with("evil.png"));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(
        !found_evil,
        "symlinked dir outside root must not be traversed"
    );
}

#[test]
fn walkdir_jail_follow_links_disabled() {
    // Verify WalkDir::follow_links(false) is set by ensuring a symlink file is not followed as dir
    // This is behavioral: with follow_links(false), a symlink to a dir containing files should not be traversed
    // Already covered above, but we explicitly check that entry.file_type().is_file() does not follow symlink dir
    let root = temp_root("jail_follow");
    let outside = temp_root("jail_follow_out");
    let _ = fs::create_dir_all(&root);
    let _ = fs::create_dir_all(&outside);
    let sub_outside = outside.join("sub");
    let _ = fs::create_dir_all(&sub_outside);
    let nested = sub_outside.join("nested.png");
    let _ = fs::write(&nested, b"nested");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = root.join("link_to_sub");
        let _ = symlink(&sub_outside, &link);
    }
    #[cfg(windows)]
    {
        let link = root.join("link_to_sub");
        let _ = std::os::windows::fs::symlink_dir(&sub_outside, &link);
    }
    let results = scan_directory(&root);
    let found_nested = results.iter().any(|f| f.path.ends_with("nested.png"));
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
    assert!(
        !found_nested,
        "with follow_links(false), nested file via symlink dir must not be found"
    );
}

#[test]
fn walkdir_jail_dotdot_path_not_escaped() {
    // Path with .. segments that would escape root if not canonicalized
    let root = temp_root("jail_dotdot");
    let _ = fs::create_dir_all(root.join("sub"));
    let inner = root.join("sub").join("ok.png");
    let _ = fs::write(&inner, b"ok");
    // Create a file outside via canonical traversal attempt: root/../outside.png should not be returned when scanning root
    // Scan root should only return ok.png, not outside
    let results = scan_directory(&root);
    let all_inside = results.iter().all(|f| {
        f.path
            .canonicalize()
            .map(|c| is_within_jail(&root.canonicalize().unwrap(), &c))
            .unwrap_or(false)
    });
    let _ = fs::remove_dir_all(&root);
    assert!(all_inside, "all returned paths must be within jail");
    // At least one file should be found (ok.png)
    assert!(!results.is_empty(), "inside file must be discovered");
}
