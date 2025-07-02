from rest_framework import serializers
from .models import Selection

class SelectionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Selection
        fields = '__all__' 