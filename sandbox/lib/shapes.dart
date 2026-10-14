import 'dart:math' as math;

/// A shape on a plane.
abstract class Shape {
  const Shape();

  /// The area of the shape.
  double area();

  /// The length of the shape's outline.
  double perimeter();

  /// A short description, for reports.
  String describe() => '$runtimeType with area ${area().toStringAsFixed(2)}';
}

/// A circle, by its radius.
class Circle extends Shape {
  const Circle(this.radius);

  final double radius;

  @override
  double area() => math.pi * radius * radius;

  @override
  double perimeter() => 2 * math.pi * radius;
}

/// A rectangle, by its sides.
class Rectangle extends Shape {
  const Rectangle(this.width, this.height);

  final double width;
  final double height;

  @override
  double area() => width * height;

  @override
  double perimeter() => 2 * (width + height);

  /// Whether both sides are equal.
  bool get isSquare => width == height;
}

/// The total area of some shapes.
double totalArea(List<Shape> shapes) {
  var total = 0.0;
  for (final shape in shapes) {
    total += shape.area();
  }
  return total;
}

/// The shape with the largest area, or null for none.
Shape? largest(List<Shape> shapes) {
  if (shapes.isEmpty) return null;
  var best = shapes.first;
  for (final shape in shapes.skip(1)) {
    if (shape.area() > best.area()) best = shape;
  }
  return best;
}

/// Shapes whose area is at least [minimum].
List<Shape> atLeast(List<Shape> shapes, double minimum) =>
    shapes.where((s) => s.area() >= minimum).toList();

/// Scales a circle.
Circle scaleCircle(Circle c, double factor) => Circle(c.radius * factor);
