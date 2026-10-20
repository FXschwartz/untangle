// Resolved Dart facts for one immutable review. JSON lines stream one file at a time;
// the process exits before JavaScript builds the review graph.
import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/token.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/source/line_info.dart';

typedef Json = Map<String, dynamic>;

final linesByPath = <String, LineInfo>{};

List<Object>? location(Element? original) {
  if (original == null) return null;
  final element = original.baseElement.nonSynthetic;
  final fragment = element.firstFragment;
  final source = fragment.libraryFragment?.source;
  if (source == null || fragment.offset < 0) return null;

  final file = source.fullName;
  final lines = linesByPath.putIfAbsent(
    file,
    () => LineInfo.fromContent(File(file).readAsStringSync()),
  );
  final at = lines.getLocation(fragment.offset);
  return [file, at.lineNumber - 1, at.columnNumber - 1];
}

String? identity(Element? element) => location(element)?.join(':');

class Facts extends GeneralizingAstVisitor<void> {
  Facts(this.result);

  final ResolvedUnitResult result;
  final declarations = <Json>[];
  final references = <String, Json>{};
  final unresolved = <String, int>{};
  final calls = <String, Map<String, List<Object>>>{};
  final supers = <String, List<Object>>{};
  final scenarios = <Json>[];
  final arguments = <Json>[];
  final owners = <String>[];
  final callableOwners = <String>[];

  String position(int offset) {
    final at = result.lineInfo.getLocation(offset);
    return '${at.lineNumber}:${at.columnNumber - 1}';
  }

  int leadingOffset(AstNode declaration) {
    var start = declaration.offset;
    final comments = [
      for (
        Token? comment = declaration.beginToken.precedingComments;
        comment != null;
        comment = comment.next
      )
        comment,
    ];

    for (final comment in comments.reversed) {
      if (comment.offset >= start) continue;
      final lineStart = comment.offset == 0
          ? 0
          : result.content.lastIndexOf('\n', comment.offset - 1) + 1;
      final endLine = result.lineInfo.getLocation(comment.end - 1).lineNumber;
      final startLine = result.lineInfo.getLocation(start).lineNumber;
      // A trailing comment belongs to the preceding declaration; a blank line separates
      // an unattached comment. Ordinary leading comments belong with this declaration.
      if (endLine < startLine - 1 ||
          result.content
              .substring(lineStart, comment.offset)
              .trim()
              .isNotEmpty) {
        break;
      }
      start = comment.offset;
    }
    return start;
  }

  void reference(
    int offset,
    int length,
    Element? element,
    String kind, {
    int priority = 1,
  }) {
    final target = location(element);
    final key = position(offset);
    if (target == null) {
      // Model classes can be unavailable when generated files are gitignored. Preserve
      // real syntax positions so navigation can consult the tracked YAML definitions.
      if (element == null &&
          RegExp(
            r'^[A-Z][A-Za-z0-9_]*$',
          ).hasMatch(result.content.substring(offset, offset + length))) {
        unresolved[key] = length;
      }
      return;
    }
    if ((references[key]?['priority'] as int? ?? -1) > priority) return;

    references[key] = {
      'offset': offset,
      'length': length,
      'target': target,
      'kind': kind,
      'elementKind': element!.kind.name,
      'name': element.displayName,
      'owner': owners.isEmpty ? null : owners.last,
      'priority': priority,
    };
  }

  // An import's or export's URI goes to the file it names, when the file is there: a generated
  // file can be missing from the checkout, though the analyzer still gives it a library.
  void uri(UriBasedDirective node, LibraryElement? library) {
    final file = library?.firstFragment.source.fullName;
    if (file == null || !File(file).existsSync()) return;
    reference(node.uri.offset, node.uri.length, library, 'uri');
  }

  void call(Element? element) {
    final target = location(element);
    if (target == null || callableOwners.isEmpty) return;
    (calls[callableOwners.last] ??= {})[target.join(':')] = target;
  }

  void inherited(Element element, int offset) {
    final owner = element.enclosingElement;
    if (owner is! InterfaceElement || element.name == null) return;

    if (element is! MethodElement && element is! PropertyAccessorElement)
      return;
    final name = Name(element.library!.uri, element.name!);
    final target =
        owner.getInheritedConcreteMember(name) ??
        owner.getInheritedMember(name);
    final at = location(target);
    if (at != null) supers[position(offset)] = at;
  }

  @override
  void visitNode(AstNode node) {
    final declared =
        node is FragmentDeclaringNode &&
            node is! CompilationUnit &&
            node is! FunctionExpression
        ? node.declaredFragment
        : null;
    final fragment = declared?.name != null || node is ExtensionDeclaration
        ? declared
        : null;
    final element = fragment?.element;
    final id =
        identity(element) ??
        (node is ExtensionDeclaration && element != null
            ? '${result.path}:${result.lineInfo.getLocation(node.offset).lineNumber - 1}:${result.lineInfo.getLocation(node.offset).columnNumber - 1}'
            : null);
    final owns = id != null;
    final callable = owns && element is ExecutableElement;

    if (owns && element != null) {
      final declaration =
          node is VariableDeclaration &&
              (element is TopLevelVariableElement || element is FieldElement)
          ? node.parent!.parent!
          : node;
      final offset = leadingOffset(declaration);
      final start = result.lineInfo.getLocation(offset);
      final end = result.lineInfo.getLocation(declaration.end - 1);
      final nameOffset = fragment!.nameOffset ?? fragment.offset;
      declarations.add({
        'id': id,
        'name': node is ExtensionDeclaration && node.name == null
            ? result.content
                  .substring(node.offset, node.body.offset)
                  .replaceAll(RegExp(r'\s+'), ' ')
                  .trim()
            : element.displayName,
        'kind': element.kind.name,
        'syntax': node.runtimeType.toString().replaceAll('Impl', ''),
        'offset': offset,
        'end': declaration.end,
        'startLine': start.lineNumber,
        'startColumn': start.columnNumber - 1,
        'signatureEndLine': result.lineInfo.getLocation(switch (node) {
          MethodDeclaration() => node.body.offset,
          FunctionDeclaration() => node.functionExpression.body.offset,
          ConstructorDeclaration() => node.body.offset,
          _ => declaration.end - 1,
        }).lineNumber,
        'endLine': end.lineNumber,
        'endColumn': end.columnNumber,
        'nameOffset': nameOffset,
        'position': position(nameOffset),
        'owner': owners.isEmpty ? null : owners.last,
        'elementOwner': identity(element.enclosingElement),
        'field': element is FieldFormalParameterElement
            ? location(element.field)
            : null,
        'type': element is VariableElement
            ? element.type.getDisplayString()
            : null,
      });
      final declarationTarget = switch (element) {
        FieldFormalParameterElement() => element.field,
        SuperFormalParameterElement() => element.superConstructorParameter,
        ConstructorElement()
            when node is ConstructorDeclaration && node.name == null =>
          element.enclosingElement,
        _ => element,
      };
      reference(
        nameOffset,
        element.displayName.length,
        declarationTarget,
        'declaration',
        priority: 3,
      );
      inherited(element, nameOffset);
      owners.add(id);
      if (callable) {
        callableOwners.add(id);
        calls.putIfAbsent(id, () => {});
      }
    }

    if (node is SimpleIdentifier) {
      reference(
        node.offset,
        node.length,
        node.element,
        'reference',
        priority: 2,
      );
      final element = node.element;
      if (element is ExecutableElement &&
          (element is! PropertyAccessorElement ||
              element.isOriginDeclaration)) {
        // Function values passed as callbacks participate in reachability too.
        call(element);
      }
    } else if (node is PatternField) {
      final name = node.name?.name;
      if (name != null) {
        reference(name.offset, name.length, node.element, 'pattern');
      }
      call(node.element);
    } else if (node is NamedType) {
      reference(node.name.offset, node.name.length, node.element, 'type');
    } else if (node is ImportPrefixReference) {
      reference(node.name.offset, node.name.length, node.element, 'prefix');
    } else if (node is ImportDirective) {
      uri(node, node.libraryImport?.importedLibrary);
    } else if (node is ExportDirective) {
      uri(node, node.libraryExport?.exportedLibrary);
    } else if (node is NamedArgument) {
      reference(
        node.name.offset,
        node.name.length,
        node.correspondingParameter,
        'argument',
        priority: 3,
      );
    } else if (node is ConstructorName) {
      final token = node.name?.token ?? node.type.name;
      reference(
        token.offset,
        token.length,
        node.element,
        'constructor',
        priority: 4,
      );
    } else if (node is MethodInvocation) {
      final target = node.methodName.element;
      call(target);
      final uri = target?.library?.uri.toString() ?? '';
      final name = target?.name ?? node.methodName.name;
      final framework =
          uri.startsWith('package:test/') ||
          uri.startsWith('package:test_api/') ||
          uri.startsWith('package:test_core/') ||
          uri.startsWith('package:flutter_test/');
      // Custom test wrappers and unresolved imports retain the review's test-call convention.
      // The resolved flag lets consumers distinguish framework calls from those candidates.
      if (name == 'test' || name == 'group' || name == 'testWidgets') {
        scenarios.add({
          'name': name,
          'uri': uri,
          'framework': framework,
          'offset': node.offset,
          'end': node.parent is ExpressionStatement
              ? node.parent!.end
              : node.end,
          'startColumn':
              result.lineInfo.getLocation(node.offset).columnNumber - 1,
          'startLine': result.lineInfo.getLocation(node.offset).lineNumber,
          'endLine': result.lineInfo.getLocation(node.end - 1).lineNumber,
          'endColumn': result.lineInfo.getLocation(node.end).columnNumber - 1,
          'target': location(target),
          'title': node.argumentList.arguments.isEmpty
              ? null
              : switch (node.argumentList.arguments.first.argumentExpression) {
                  StringLiteral literal =>
                    literal.stringValue ?? literal.toSource(),
                  final expression => expression.toSource(),
                },
        });
      }
    } else if (node is InstanceCreationExpression) {
      call(node.constructorName.element);
    }

    if (node is MethodReferenceExpression) call(node.element);
    if (node is Argument) {
      final target = location(node.correspondingParameter);
      if (target != null) {
        arguments.add({
          'offset': node.offset,
          'end': node.end,
          'target': target,
          'named': node is NamedArgument,
          'callable': location(node.correspondingParameter?.enclosingElement),
          'startLine': result.lineInfo.getLocation(node.offset).lineNumber,
          'startColumn':
              result.lineInfo.getLocation(node.offset).columnNumber - 1,
          'endLine': result.lineInfo.getLocation(node.end - 1).lineNumber,
          'endColumn': result.lineInfo.getLocation(node.end).columnNumber - 1,
        });
      }
    }
    if (node is CompoundAssignmentExpression) {
      final operand = switch (node) {
        AssignmentExpression() => node.leftHandSide,
        PrefixExpression() => node.operand,
        PostfixExpression() => node.operand,
        _ => null,
      };
      final name = switch (operand) {
        SimpleIdentifier() => operand,
        PrefixedIdentifier() => operand.identifier,
        PropertyAccess() => operand.propertyName,
        _ => null,
      };
      if (name != null) {
        reference(
          name.offset,
          name.length,
          node.readElement ?? node.writeElement,
          'assignment',
          priority: 3,
        );
      }
      call(node.readElement);
      call(node.writeElement);
    }

    super.visitNode(node);

    if (owns) owners.removeLast();
    if (callable) callableOwners.removeLast();
  }

  Json toJson() => {
    'path': result.path,
    'declarations': declarations,
    'directives': result.unit.directives
        .map(
          (directive) => {
            'startLine': result.lineInfo
                .getLocation(directive.offset)
                .lineNumber,
            'endLine': result.lineInfo
                .getLocation(directive.end - 1)
                .lineNumber,
          },
        )
        .toList(),
    'references': references,
    'unresolved': unresolved,
    'calls': calls.map((key, value) => MapEntry(key, value.values.toList())),
    'supers': supers,
    'scenarios': scenarios,
    'arguments': arguments,
    'diagnostics': result.diagnostics
        .map(
          (error) => {
            'code': error.diagnosticCode.lowerCaseName,
            'severity': error.diagnosticCode.severity.name,
            'offset': error.offset,
            'message': error.message,
          },
        )
        .toList(),
  };
}

Future<void> main() async {
  final collections = <AnalysisContextCollection>[];
  String? sdk;
  var extracted = 0;
  final lifetime = Stopwatch()..start();

  try {
    await for (final line
        in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
      final input = jsonDecode(line) as Json;
      final timer = Stopwatch()..start();
      try {
        dynamic value;
        switch (input['method']) {
          case 'initialize':
            sdk = input['sdk'] as String;
            final collection = AnalysisContextCollection(
              includedPaths: (input['paths'] as List).cast<String>(),
              sdkPath: sdk,
            );
            collections.add(collection);
            value = {'contexts': collection.contexts.length};
          case 'files':
            final files = <Json>[];
            for (final file in (input['paths'] as List).cast<String>()) {
              {
                // Explicitly requested files can be excluded from background analysis.
                var contexts =
                    collections
                        .expand((collection) => collection.contexts)
                        .where(
                          (context) => context.contextRoot.root.contains(file),
                        )
                        .toList()
                      ..sort(
                        (a, b) => b.contextRoot.root.path.length.compareTo(
                          a.contextRoot.root.path.length,
                        ),
                      );
                if (contexts.isEmpty) {
                  // Call traversal can reach a package with no initially changed files.
                  final collection = AnalysisContextCollection(
                    includedPaths: [file],
                    sdkPath: sdk,
                  );
                  collections.add(collection);
                  contexts = collection.contexts.toList();
                }
                if (contexts.isEmpty) throw StateError('No context for $file');
                final result = await contexts.first.currentSession
                    .getResolvedUnit(file);
                if (result is! ResolvedUnitResult) {
                  throw StateError('$file returned ${result.runtimeType}');
                }
                linesByPath[file] = result.lineInfo;
                final facts = Facts(result);
                result.unit.accept(facts);
                final output = facts.toJson();
                if (input['callsOnly'] == true) {
                  output.removeWhere(
                    (key, _) => key != 'path' && key != 'calls',
                  );
                }
                files.add(output);
                extracted++;
              }
            }
            value = files;
          case 'shutdown':
            value = {'files': extracted};
          default:
            throw ArgumentError('Unknown method ${input['method']}');
        }
        stdout.writeln(
          jsonEncode({
            'id': input['id'],
            'result': value,
            'ms': timer.elapsedMicroseconds / 1000,
            'lifetimeMs': lifetime.elapsedMicroseconds / 1000,
            'rss': ProcessInfo.currentRss,
            'peakRss': ProcessInfo.maxRss,
          }),
        );
        if (input['method'] == 'shutdown') break;
      } catch (error, stack) {
        stdout.writeln(
          jsonEncode({'id': input['id'], 'error': '$error', 'stack': '$stack'}),
        );
      }
    }
  } finally {
    for (final collection in collections) {
      await collection.dispose();
    }
  }
}
