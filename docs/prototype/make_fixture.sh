#!/usr/bin/env bash
# Builds a small repo that exercises the generated-code adapters (freezed-style part files and
# protobuf), in three commits: base, head (a new field in each model and code that reads it),
# and head2 (head with `.review.yaml` turning the protobuf adapter off).
#   make_fixture.sh <dir>   then   run_pr.sh <dir> <out> <base> <head>
set -euo pipefail
F=$1
rm -rf "$F" && mkdir -p "$F/lib" "$F/proto" && cd "$F"
git init -q -b main && git config user.email fixture@example.com && git config user.name fixture
printf 'name: fixture\npublish_to: none\nenvironment:\n  sdk: ^3.5.0\n' > pubspec.yaml
cat > lib/user.dart <<'EOF'
part 'user.freezed.dart';

class User with _$User {
  const factory User({required String name}) = _User;
}
EOF
cat > lib/user.freezed.dart <<'EOF'
part of 'user.dart';

mixin _$User {
  String get name => throw UnimplementedError();
  $UserCopyWith<User> get copyWith => throw UnimplementedError();
}

abstract class $UserCopyWith<T> {
  T call({String? name});
}

class _User with _$User implements User {
  const _User({required this.name});

  @override
  final String name;
}
EOF
printf "import 'user.dart';\n\nString greet(User user) => 'Hello \${user.name}';\n" > lib/greeting.dart
printf 'syntax = "proto3";\n\nmessage Account {\n  string owner_name = 1;\n}\n' > proto/account.proto
printf "class Account {\n  String get ownerName => '';\n  bool hasOwnerName() => false;\n}\n" > lib/account.pb.dart
printf "import 'account.pb.dart';\n\nString owner(Account account) => account.ownerName;\n" > lib/billing.dart
git add -A && git commit -q -m base
cat > lib/user.dart <<'EOF'
part 'user.freezed.dart';

class User with _$User {
  const factory User({
    required String name,
    required String email,
  }) = _User;
}
EOF
cat > lib/user.freezed.dart <<'EOF'
part of 'user.dart';

mixin _$User {
  String get name => throw UnimplementedError();
  String get email => throw UnimplementedError();
  $UserCopyWith<User> get copyWith => throw UnimplementedError();
}

abstract class $UserCopyWith<T> {
  T call({String? name, String? email});
}

class _User with _$User implements User {
  const _User({required this.name, required this.email});

  @override
  final String name;
  @override
  final String email;
}
EOF
printf "import 'user.dart';\n\nString greet(User user) => 'Hello \${user.name}';\n\nString contact(User user) => user.email;\n" > lib/greeting.dart
printf 'syntax = "proto3";\n\nmessage Account {\n  string owner_name = 1;\n  string billing_email = 2;\n}\n' > proto/account.proto
printf "class Account {\n  String get ownerName => '';\n  bool hasOwnerName() => false;\n  String get billingEmail => '';\n  bool hasBillingEmail() => false;\n}\n" > lib/account.pb.dart
printf "import 'account.pb.dart';\n\nString owner(Account account) => account.ownerName;\n\nString billTo(Account account) => account.billingEmail;\n" > lib/billing.dart
git add -A && git commit -q -m head
printf 'adapters:\n  protobuf: false\n' > .review.yaml
git add -A && git commit -q -m 'head with the protobuf adapter off'
git log --format='%h %s'
