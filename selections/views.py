from django.shortcuts import render
from rest_framework import viewsets, permissions
from .models import Selection
from .serializers import SelectionSerializer

# Create your views here.

class SelectionViewSet(viewsets.ModelViewSet):
    queryset = Selection.objects.all()
    serializer_class = SelectionSerializer
    permission_classes = [permissions.IsAuthenticatedOrReadOnly]
