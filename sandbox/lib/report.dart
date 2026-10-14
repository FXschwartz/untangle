import 'shapes.dart';

/// Lines describing some shapes, one per shape.
List<String> report(List<Shape> shapes) {
  final lines = <String>[];
  for (final shape in shapes) {
    lines.add(shape.describe());
  }
  lines.add('Total area: ${totalArea(shapes).toStringAsFixed(2)}');
  final big = largest(shapes);
  if (big != null) lines.add('Largest: ${big.describe()}');
  return lines;
}

/// Prints the report for a fixed set of shapes.
void main() {
  final shapes = <Shape>[
    const Circle(1),
    const Rectangle(2, 3),
    const Rectangle(4, 4),
  ];
  for (final line in report(shapes)) {
    print(line);
  }
  print('Big ones: ${atLeast(shapes, 10).length}');
}
