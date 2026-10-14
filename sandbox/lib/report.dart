import 'shapes.dart';

/// Lines describing some shapes, one per shape, with areas to [digits] decimals.
List<String> report(List<Shape> shapes, {int digits = 2}) {
  final lines = <String>[];
  for (final shape in shapes) {
    lines.add(shape.describe(digits: digits));
  }
  lines.add('Total area: ${totalArea(shapes).toStringAsFixed(digits)}');
  final big = largest(shapes);
  if (big != null) lines.add('Largest: ${big.describe(digits: digits)}');
  return lines;
}

/// Prints the report for a fixed set of shapes (a third commit, for untangle's refresh test).
void main() {
  final shapes = <Shape>[
    const Circle(1),
    const Rectangle(2, 3),
    const Rectangle(4, 4),
    const Triangle(3, 4, 5),
  ];
  for (final line in report(shapes, digits: 1)) {
    print(line);
  }
}
